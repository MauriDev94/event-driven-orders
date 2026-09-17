from shared.contracts.base_event import BaseEvent


class StockReserved(BaseEvent):
    """Published by inventory-service when stock was reserved for an order.

    Consumed by order-service to confirm the order.
    """

    event_type: str = "stock.reserved"
    order_id: str


class StockRejected(BaseEvent):
    """Published by inventory-service when stock could not be reserved.

    Consumed by order-service to reject the order.
    """

    event_type: str = "stock.rejected"
    order_id: str
    reason: str
