"""Inbound event handler: consumes ``OrderCreated`` to reserve stock.

Presentation layer entry point — the broker equivalent of an HTTP route. This
module does only transport concerns:

1. Deserialize the raw message body into an ``OrderCreated`` contract.
2. Build ``ReserveStockParams`` and invoke the use case.
3. ACK the message on success.

No business logic lives here: the use case handles idempotency, the atomic
reservation and the StockReserved/StockRejected publication.

``build_order_created_handler`` is a factory that closes over a fully-wired
``ReserveStock`` instance, returning the coroutine expected by aio-pika's
``queue.consume``.  This factory pattern makes the handler unit-testable
without a real broker.
"""

import logging
import time
from collections.abc import Awaitable, Callable

import aio_pika
from shared.contracts.order_events import OrderCreated
from shared.observability.metrics import EVENT_PROCESSING_SECONDS, EVENTS_PROCESSED

from app.features.inventory.application.usecases.reserve_stock_use_case import (
    ReserveStock,
    ReserveStockItem,
    ReserveStockParams,
)

logger = logging.getLogger(__name__)

MessageHandler = Callable[[aio_pika.abc.AbstractIncomingMessage], Awaitable[None]]


def build_order_created_handler(
    use_case: ReserveStock, *, service_name: str = "inventory-service"
) -> MessageHandler:
    """Return a coroutine that handles a single ``OrderCreated`` message.

    The returned function is passed directly to ``aio_pika.Queue.consume``.
    It always ACKs the message — if the use case detects a duplicate it
    ACKs without re-processing; if the use case raises unexpectedly the
    exception bubbles up and aio-pika will NACK/dead-letter the message.
    """

    async def handle(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        start = time.perf_counter()
        event = OrderCreated.model_validate_json(message.body)
        params = ReserveStockParams(
            order_id=event.order_id,
            event_id=event.event_id,
            correlation_id=event.correlation_id,
            items=[
                ReserveStockItem(product_id=item.product_id, quantity=item.quantity)
                for item in event.items
            ],
        )
        result = await use_case.execute(params)
        if result.duplicate:
            logger.info("duplicate event %s — skipped", event.event_id)
        else:
            EVENTS_PROCESSED.labels(service=service_name, event_type=event.event_type).inc()
            EVENT_PROCESSING_SECONDS.labels(service=service_name).observe(
                time.perf_counter() - start
            )
        await message.ack()

    return handle
