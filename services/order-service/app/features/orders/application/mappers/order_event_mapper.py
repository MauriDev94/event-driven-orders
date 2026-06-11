"""Map the Order domain entity to the OrderCreated integration event.

This lives in the application layer: emitting integration events is an
application concern. The domain stays free of the wire contract, and the
broker/aio-pika detail stays behind the EventPublisher port.
"""

from shared.contracts.order_events import OrderConfirmed, OrderCreated, OrderItem, OrderRejected
from shared.observability.context import get_correlation_id

from app.features.orders.domain.entities.order import Order


def map_order_to_order_confirmed(
    order_id: str, customer_id: str, correlation_id: str
) -> OrderConfirmed:
    return OrderConfirmed(correlation_id=correlation_id, order_id=order_id, customer_id=customer_id)


def map_order_to_order_rejected(
    order_id: str, customer_id: str, correlation_id: str, reason: str
) -> OrderRejected:
    return OrderRejected(
        correlation_id=correlation_id,
        order_id=order_id,
        customer_id=customer_id,
        reason=reason,
    )


def map_order_to_order_created(order: Order) -> OrderCreated:
    """Build the ``OrderCreated`` contract from a persisted order.

    ``correlation_id`` is the HTTP request's correlation id (bound by
    ``correlation_id_middleware``), so every downstream event of this order's
    lifecycle (stock.reserved -> order.confirmed, ...) can be traced back to
    the originating request. Falls back to the order id when no request
    context is bound (e.g. unit tests, non-HTTP callers).
    """
    return OrderCreated(
        correlation_id=get_correlation_id() or order.id or "",
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
