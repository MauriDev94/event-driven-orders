"""SQLAlchemy implementation of the InventoryRepository port.

This module contains the two atomic primitives that the ReserveStock use case
orchestrates inside a single Unit of Work transaction:

* ``register_event``: idempotency guard — inserts the event_id once and
  returns False on duplicate (IntegrityError on the PK).

* ``reserve_all``: all-or-nothing, race-condition-safe stock decrement.
  Each line uses an UPDATE with a WHERE clause that guards the minimum stock:

      UPDATE products
      SET    available_quantity = available_quantity - :qty
      WHERE  sku = :sku
      AND    available_quantity >= :qty

  PostgreSQL evaluates the WHERE atomically under row-level locking, so two
  concurrent transactions cannot oversell the same SKU. If any line cannot be
  decremented (rowcount == 0), a SAVEPOINT lets us roll back only the lines
  touched so far before returning the failing SKU — the caller (UoW) still
  commits the event_id record so the message is not redelivered forever.
"""

from sqlalchemy import text
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from app.features.inventory.application.contracts.inventory_repository import (
    InventoryRepository,
    ReservationItem,
)


class SqlAlchemyInventoryRepository(InventoryRepository):
    """Operates on the session provided by the Unit of Work — never commits."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def register_event(self, event_id: str) -> bool:
        """Insert event_id; return False (already seen) on duplicate PK.

        Uses ``INSERT ... ON CONFLICT DO NOTHING`` so no exception is raised
        on a duplicate — the session state stays clean inside the enclosing
        transaction. ``rowcount == 0`` means a duplicate was silently ignored.
        """
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        from app.features.inventory.infrastructure.models.processed_event_model import (
            ProcessedEventModel,
        )

        stmt = pg_insert(ProcessedEventModel).values(event_id=event_id).on_conflict_do_nothing()
        result: CursorResult = self._session.execute(stmt)  # type: ignore[assignment]
        return result.rowcount > 0

    def reserve_all(self, items: list[ReservationItem]) -> str | None:
        """Conditional UPDATE per line; roll back partial changes on failure.

        Uses a SAVEPOINT so a failed line does not invalidate the enclosing
        transaction — the Unit of Work can still commit the event_id record
        even when the reservation is rejected.
        """
        self._session.execute(text("SAVEPOINT reserve_all"))
        for item in items:
            result: CursorResult = self._session.execute(  # type: ignore[assignment]
                text(
                    "UPDATE products "
                    "SET available_quantity = available_quantity - :qty "
                    "WHERE sku = :sku AND available_quantity >= :qty"
                ),
                {"qty": item.quantity, "sku": item.sku},
            )
            if result.rowcount == 0:
                self._session.execute(text("ROLLBACK TO SAVEPOINT reserve_all"))
                return item.sku
        self._session.execute(text("RELEASE SAVEPOINT reserve_all"))
        return None
