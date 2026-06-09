from abc import ABC, abstractmethod

from app.features.orders.domain.entities.order import Order


class OrderUnitOfWork(ABC):
    """Transactional boundary for the confirm/reject order flow.

    Encapsulates three atomic operations that must commit together:
    1. Record the incoming event_id (idempotency guard).
    2. Load the order aggregate.
    3. Persist the mutated aggregate.

    The Unit of Work owns the transaction — use cases call ``commit()``
    explicitly; the context-manager ``__exit__`` rolls back on exception.
    """

    @abstractmethod
    def register_event(self, event_id: str) -> bool:
        """Insert event_id; return False if it was already processed (duplicate)."""
        ...

    @abstractmethod
    def get_order(self, order_id: str) -> Order | None:
        """Return the Order aggregate by id, or None if not found."""
        ...

    @abstractmethod
    def save_order(self, order: Order) -> None:
        """Flush the mutated aggregate to the session (no commit — UoW controls that)."""
        ...

    @abstractmethod
    def commit(self) -> None: ...

    @abstractmethod
    def rollback(self) -> None: ...

    def __enter__(self) -> "OrderUnitOfWork":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        if exc_type is not None:
            self.rollback()
