"""Inbound event handler: consumes ``OrderCreated`` to reserve stock.

SCAFFOLD STUB. In Phase 2 this consumer binds to the
``inventory-service.order-created`` queue, deserializes the OrderCreated
contract, invokes ReserveStock and publishes the result. Consumers are
presentation-layer entry points (the broker equivalent of an HTTP route).
"""

import aio_pika


async def handle_order_created(message: aio_pika.abc.AbstractIncomingMessage) -> None:
    """Handle a single OrderCreated message. Implemented in Phase 2."""
    raise NotImplementedError("order created consumer is implemented in Phase 2")
