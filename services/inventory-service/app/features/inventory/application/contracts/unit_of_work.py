from abc import ABC, abstractmethod

from app.features.inventory.application.contracts.inventory_repository import (
    InventoryRepository,
)


class UnitOfWork(ABC):
    """Transaction boundary for the stock reservation flow.

    The idempotency check (recording ``event_id``) and the stock decrements
    must commit or roll back together — that single-transaction atomicity is
    what makes the consumer safe under RabbitMQ's at-least-once delivery.

    Used as a context manager: on a clean exit nothing is auto-committed (the
    use case commits explicitly); on an exception the transaction is rolled
    back. The bound ``inventory`` repository shares the unit's session.
    """

    inventory: InventoryRepository

    @abstractmethod
    def __enter__(self) -> "UnitOfWork": ...

    @abstractmethod
    def __exit__(self, exc_type: object, exc: object, tb: object) -> None: ...

    @abstractmethod
    def commit(self) -> None:
        """Persist everything done in this unit of work."""
        ...

    @abstractmethod
    def rollback(self) -> None:
        """Discard everything done in this unit of work."""
        ...
