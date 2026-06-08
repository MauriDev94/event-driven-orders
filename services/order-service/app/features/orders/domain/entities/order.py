from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from enum import Enum


class OrderStatus(str, Enum):
    """Lifecycle states of an order."""

    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"


@dataclass(slots=True)
class OrderLine:
    """A single product line within an order."""

    product_id: str
    quantity: int
    unit_price: Decimal

    def __post_init__(self) -> None:
        if not self.product_id.strip():
            raise ValueError("product_id cannot be empty")
        if self.quantity <= 0:
            raise ValueError("quantity must be positive")
        if self.unit_price < 0:
            raise ValueError("unit_price cannot be negative")

    @property
    def subtotal(self) -> Decimal:
        return self.unit_price * self.quantity


@dataclass(slots=True)
class Order:
    """Order aggregate root with explicit lifecycle behavior.

    Invariants and state transitions live here — use cases orchestrate,
    the domain enforces the rules.
    """

    id: str | None
    customer_id: str
    lines: list[OrderLine]
    status: OrderStatus = OrderStatus.PENDING
    rejection_reason: str | None = None
    created_at: datetime | None = field(default=None)
    updated_at: datetime | None = field(default=None)

    def __post_init__(self) -> None:
        if not self.customer_id.strip():
            raise ValueError("customer_id cannot be empty")
        if not self.lines:
            raise ValueError("an order must have at least one line")

    @property
    def total_amount(self) -> Decimal:
        return sum((line.subtotal for line in self.lines), Decimal("0"))

    def confirm(self) -> None:
        """Confirm the order once stock has been reserved."""
        if self.status is not OrderStatus.PENDING:
            raise ValueError(f"cannot confirm an order in status {self.status.value}")
        self.status = OrderStatus.CONFIRMED
        self._mark_as_updated()

    def reject(self, reason: str) -> None:
        """Reject the order when it cannot be fulfilled."""
        if self.status is not OrderStatus.PENDING:
            raise ValueError(f"cannot reject an order in status {self.status.value}")
        self.status = OrderStatus.REJECTED
        self.rejection_reason = reason.strip() or "unspecified"
        self._mark_as_updated()

    def _mark_as_updated(self) -> None:
        self.updated_at = datetime.now(UTC)
