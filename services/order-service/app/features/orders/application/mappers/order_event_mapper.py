"""Map the Order domain entity to the OrderCreated integration event.

This lives in the application layer: emitting integration events is an
application concern. The domain stays free of the wire contract, and the
broker/aio-pika detail stays behind the EventPublisher port.
"""

from shared.contracts.order_events import OrderCreated, OrderItem

from app.features.orders.domain.entities.order import Order


def map_order_to_order_created(order: Order) -> OrderCreated:
    """Build the ``OrderCreated`` contract from a persisted order.

    ``correlation_id`` is set to the order id so every downstream event of
    this order's lifecycle (stock.reserved -> order.confirmed, ...) can be
    traced back to a single business flow.
    """
    return OrderCreated(
        correlation_id=order.id or "",
        order_id=order.id or "",
        customer_id=order.customer_id,
        items=[
            OrderItem(
                product_id=line.product_id,
                quantity=line.quantity,
                unit_price=line.unit_price,
            )
            for line in order.lines
        ],
        total_amount=order.total_amount,
    )
