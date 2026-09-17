from decimal import Decimal

from pydantic import BaseModel, Field

from shared.contracts.base_event import BaseEvent


class OrderItem(BaseModel):
    """A single line item inside an order, as it travels on the wire."""

    product_id: str
    quantity: int = Field(gt=0)
    unit_price: Decimal = Field(ge=0)


class OrderCreated(BaseEvent):
    """Published by order-service when a new order is placed.

    Consumed by inventory-service to attempt stock reservation.
    """

    event_type: str = "order.created"
    order_id: str
    customer_id: str
    items: list[OrderItem]
    total_amount: Decimal = Field(ge=0)


class OrderConfirmed(BaseEvent):
    """Published by order-service once stock was successfully reserved.

    Consumed by notification-service to inform the customer.
    """

    event_type: str = "order.confirmed"
    order_id: str
    customer_id: str


class OrderRejected(BaseEvent):
    """Published by order-service when the order cannot be fulfilled.

    Consumed by notification-service to inform the customer.
    """

    event_type: str = "order.rejected"
    order_id: str
    customer_id: str
    reason: str
