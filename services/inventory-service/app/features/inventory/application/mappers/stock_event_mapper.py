"""Map a reservation outcome to the StockReserved/StockRejected contracts.

Emitting integration events is an application concern: the domain stays free of
the wire contract and the broker/aio-pika detail stays behind the
``EventPublisher`` port. ``correlation_id`` is propagated from the originating
``OrderCreated`` so the whole order flow stays traceable end to end.
"""

from shared.contracts.inventory_events import StockRejected, StockReserved


def map_to_stock_reserved(order_id: str, correlation_id: str) -> StockReserved:
    """Build ``StockReserved`` for an order whose stock was fully reserved."""
    return StockReserved(correlation_id=correlation_id, order_id=order_id)


def map_to_stock_rejected(order_id: str, correlation_id: str, reason: str) -> StockRejected:
    """Build ``StockRejected`` for an order that could not be fulfilled."""
    return StockRejected(correlation_id=correlation_id, order_id=order_id, reason=reason)
