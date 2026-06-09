"""Inbound event handler: consumes inventory results to confirm or reject orders.

Presentation-layer entry point — the broker equivalent of an HTTP route.
Transport concerns only:

1. Deserialize the raw message body; dispatch on ``event_type``.
2. Build params and invoke the correct use case.
3. ACK on success (duplicates are also ACKed — the use case handles them).

``build_inventory_result_handler`` is a factory that closes over the fully-wired
``ConfirmOrder`` and ``RejectOrder`` instances, returning the coroutine expected
by aio-pika's ``queue.consume``.  This factory pattern makes the handler
unit-testable without a real broker.
"""

import json
import logging
from collections.abc import Awaitable, Callable

import aio_pika
from shared.contracts.inventory_events import StockRejected, StockReserved

from app.features.orders.application.usecases.confirm_order_use_case import (
    ConfirmOrder,
    ConfirmOrderParams,
)
from app.features.orders.application.usecases.reject_order_use_case import (
    RejectOrder,
    RejectOrderParams,
)

logger = logging.getLogger(__name__)

MessageHandler = Callable[[aio_pika.abc.AbstractIncomingMessage], Awaitable[None]]


def build_inventory_result_handler(
    confirm_use_case: ConfirmOrder,
    reject_use_case: RejectOrder,
) -> MessageHandler:
    """Return a coroutine that routes a single inventory-result message.

    ``StockReserved``  → ConfirmOrder → publishes OrderConfirmed.
    ``StockRejected``  → RejectOrder  → publishes OrderRejected.
    Duplicates (same event_id seen before) → ACK without re-processing.
    Unknown event_type → NACK to dead-letter queue.
    """

    async def handle(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        body = json.loads(message.body)
        event_type = body.get("event_type")

        if event_type == "stock.reserved":
            event = StockReserved.model_validate(body)
            confirm_params = ConfirmOrderParams(
                order_id=event.order_id,
                event_id=event.event_id,
                correlation_id=event.correlation_id,
            )
            confirm_result = await confirm_use_case.execute(confirm_params)
            if confirm_result.duplicate:
                logger.info("duplicate StockReserved %s — skipped", event.event_id)

        elif event_type == "stock.rejected":
            event = StockRejected.model_validate(body)
            reject_params = RejectOrderParams(
                order_id=event.order_id,
                event_id=event.event_id,
                correlation_id=event.correlation_id,
                reason=event.reason,
            )
            reject_result = await reject_use_case.execute(reject_params)
            if reject_result.duplicate:
                logger.info("duplicate StockRejected %s — skipped", event.event_id)

        else:
            logger.warning("unknown event_type '%s' — dead-lettering message", event_type)
            await message.nack(requeue=False)
            return

        await message.ack()

    return handle
