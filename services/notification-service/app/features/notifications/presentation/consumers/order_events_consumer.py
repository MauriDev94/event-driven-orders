"""Inbound event handler: consumes order outcomes to notify the customer.

SCAFFOLD STUB. In Phase 4 this consumer binds to the
``notification-service.order-outcomes`` queue, deserializes OrderConfirmed /
OrderRejected and invokes SendOrderNotification. Consumers are
presentation-layer entry points (the broker equivalent of an HTTP route).
"""

import aio_pika


async def handle_order_outcome(message: aio_pika.abc.AbstractIncomingMessage) -> None:
    """Handle a single order-outcome message. Implemented in Phase 4."""
    raise NotImplementedError("order outcome consumer is implemented in Phase 4")
