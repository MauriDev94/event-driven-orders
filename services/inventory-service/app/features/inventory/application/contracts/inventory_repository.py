from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class ReservationItem:
    """A single line to reserve. ``sku`` is the cross-service catalog id that
    travels on ``OrderCreated.items[*].product_id``."""

    sku: str
    quantity: int


class InventoryRepository(ABC):
    """Persistence port for the stock reservation flow.

    Exposes the two atomic primitives the use case orchestrates inside a single
    Unit of Work transaction:

    - ``register_event``: the idempotency guard (processed_events table).
    - ``reserve_all``: the all-or-nothing, race-condition-safe stock decrement.

    The transaction boundary itself lives in the ``UnitOfWork`` port — these
    methods never commit on their own.
    """

    @abstractmethod
    def register_event(self, event_id: str) -> bool:
        """Record ``event_id`` as processed.

        Returns ``True`` if it was newly recorded, ``False`` if it already
        existed — a duplicate delivery that must be skipped (idempotency).
        """
        ...

    @abstractmethod
    def reserve_all(self, items: list[ReservationItem]) -> str | None:
        """Atomically reserve every line, all-or-nothing.

        Each line is decremented with a conditional ``UPDATE ... WHERE
        available_quantity >= :qty`` so two concurrent reservations can never
        oversell. If any line cannot be satisfied, every decrement in this call
        is rolled back (savepoint) and the offending sku is returned. Returns
        ``None`` when all lines were reserved.
        """
        ...
