from dataclasses import dataclass


@dataclass(slots=True)
class Product:
    """Product stock aggregate.

    Tracks available units and enforces the core inventory invariant:
    you cannot reserve more than what is available. Reservation logic lives
    here in the domain — the use case only orchestrates.
    """

    id: str | None
    sku: str
    available_quantity: int

    def __post_init__(self) -> None:
        if not self.sku.strip():
            raise ValueError("sku cannot be empty")
        if self.available_quantity < 0:
            raise ValueError("available_quantity cannot be negative")

    def can_reserve(self, quantity: int) -> bool:
        """Whether ``quantity`` units can be reserved right now."""
        return quantity > 0 and quantity <= self.available_quantity

    def reserve(self, quantity: int) -> None:
        """Reserve units, decrementing availability.

        Raises ValueError if the quantity is invalid or insufficient — this
        is the rule that decides StockReserved vs StockRejected upstream.
        """
        if quantity <= 0:
            raise ValueError("reservation quantity must be positive")
        if quantity > self.available_quantity:
            raise ValueError("insufficient stock")
        self.available_quantity -= quantity

    def restock(self, quantity: int) -> None:
        """Add units back to availability (e.g. compensating action)."""
        if quantity <= 0:
            raise ValueError("restock quantity must be positive")
        self.available_quantity += quantity
