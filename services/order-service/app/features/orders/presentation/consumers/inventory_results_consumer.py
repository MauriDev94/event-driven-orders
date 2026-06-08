"""Inbound event handler: consumes inventory results for orders.

SCAFFOLD STUB. In later phases this consumer binds to the
``order-service.inventory-results`` queue and reacts to ``StockReserved`` /
``StockRejected`` by confirming or rejecting the corresponding order.
Consumers are presentation-layer entry points — the broker equivalent of an
HTTP route — so they live here, not in infrastructure.
"""

import aio_pika


async def handle_inventory_result(message: aio_pika.abc.AbstractIncomingMessage) -> None:
    """Handle a single inventory-result message. Implemented in Phase 3."""
    raise NotImplementedError("inventory results consumer is implemented in Phase 3")
