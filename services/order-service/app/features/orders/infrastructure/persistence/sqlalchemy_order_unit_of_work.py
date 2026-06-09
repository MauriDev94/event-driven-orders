"""SQLAlchemy implementation of the OrderUnitOfWork port.

Manages the transaction that atomically records the incoming event_id
(idempotency) and mutates the order aggregate (confirm / reject).

Intentionally separate from the HTTP-path ``SqlAlchemyOrderRepository``
(which commits internally per request).  The UoW owns the transaction:
use cases call ``commit()``; the context-manager rolls back on exception.
"""

from sqlalchemy.orm import Session, sessionmaker

from app.core.exceptions.exceptions import NotFoundError
from app.features.orders.application.contracts.unit_of_work import OrderUnitOfWork
from app.features.orders.domain.entities.order import Order
from app.features.orders.infrastructure.mappers.order_mapper import (
    map_order_model_to_entity,
)
from app.features.orders.infrastructure.models.order_model import OrderModel
from app.features.orders.infrastructure.models.processed_event_model import ProcessedEventModel


class SqlAlchemyOrderUnitOfWork(OrderUnitOfWork):
    """Opens a session on enter, exposes the transactional order operations, and
    guarantees the session is closed on exit regardless of outcome.

    Each context-manager entry creates a **new** session from the factory, so
    the same UoW instance can be reused across multiple use-case invocations
    (e.g. a consumer that handles many messages with a single use-case object).
    """

    def __init__(self, session_factory: sessionmaker) -> None:  # type: ignore[type-arg]
        self._session_factory = session_factory
        self._session: Session | None = None

    def __enter__(self) -> "SqlAlchemyOrderUnitOfWork":
        self._session = self._session_factory()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        if exc_type is not None:
            self.rollback()
        if self._session is not None:
            self._session.close()

    def register_event(self, event_id: str) -> bool:
        """Insert event_id; return False on duplicate (INSERT … ON CONFLICT DO NOTHING).

        Uses Postgres's ``on_conflict_do_nothing`` so no exception is raised
        on a duplicate — the session state stays clean inside the transaction.
        ``rowcount == 0`` means a duplicate was silently ignored.
        """
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        stmt = pg_insert(ProcessedEventModel).values(event_id=event_id).on_conflict_do_nothing()
        result = self._session.execute(stmt)  # type: ignore[union-attr]
        return result.rowcount > 0  # type: ignore[union-attr]

    def get_order(self, order_id: str) -> Order | None:
        model = self._session.get(OrderModel, order_id)  # type: ignore[union-attr]
        return map_order_model_to_entity(model) if model is not None else None

    def save_order(self, order: Order) -> None:
        """Persist the mutated aggregate without committing (UoW controls commit)."""
        model = self._session.get(OrderModel, order.id)  # type: ignore[union-attr]
        if model is None:
            raise NotFoundError(f"order {order.id} not found")
        model.status = order.status.value
        model.rejection_reason = order.rejection_reason
        self._session.flush()  # type: ignore[union-attr]

    def commit(self) -> None:
        if self._session is None:
            raise RuntimeError("OrderUnitOfWork not entered")
        self._session.commit()

    def rollback(self) -> None:
        if self._session is not None:
            self._session.rollback()
