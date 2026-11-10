from abc import ABC, abstractmethod

from app.features.orders.domain.entities.order import Order


class OrderRepository(ABC):
    """Persistence port for the Order aggregate. Implemented in infrastructure."""

    @abstractmethod
    def add(self, order: Order) -> Order:
        """Persist a new order and return it with its assigned id."""
        ...

    @abstractmethod
    def get_by_id(self, order_id: str) -> Order | None:
        """Return the order by id, or None if it does not exist."""
        ...

    @abstractmethod
    def get_by_id_for_customer(self, order_id: str, customer_id: str) -> Order | None:
        """Return the order only if it belongs to the customer.

        Someone else's order and a missing one are indistinguishable: both
        come back as None from the same single query (ADR-0027).
        """
        ...

    @abstractmethod
    def update(self, order: Order) -> Order:
        """Persist changes to an existing order."""
        ...
