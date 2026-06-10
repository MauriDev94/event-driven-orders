"""Inbound event handler: consumes order outcomes to notify the customer.

Presentation-layer entry point — the broker equivalent of an HTTP route.
Transport concerns only:

1. Deserialize the raw message body; dispatch on ``event_type``.
2. Skip already-seen ``event_id`` (idempotency, see below).
3. Map the event to use-case params and invoke ``SendOrderNotification``.
4. ACK on success; NACK (dead-letter) unknown event types.

``build_order_events_handler`` is a factory that closes over the fully-wired
``SendOrderNotification`` instance and an ``InMemoryEventDeduplicator``,
returning the coroutine expected by aio-pika's ``queue.consume``. This makes
the handler unit-testable without a real broker or SMTP server.

Idempotency note (Phase 5): this service has no database by design, so
duplicates are tracked with an in-memory, bounded ``event_id`` set instead of
a ``processed_events`` table. This covers redeliveries within a process
lifetime (the common case once retries are introduced); a redelivery shortly
after a restart can still send a duplicate email — documented limitation,
see README.
"""

import json
import logging
from collections.abc import Awaitable, Callable

import aio_pika
from shared.contracts.order_events import OrderConfirmed, OrderRejected

from app.features.notifications.application.mappers.order_event_mapper import (
    map_order_confirmed_to_params,
    map_order_rejected_to_params,
)
from app.features.notifications.application.usecases.send_order_notification_use_case import (
    SendOrderNotification,
)
from app.features.notifications.infrastructure.dedup.in_memory_event_deduplicator import (
    InMemoryEventDeduplicator,
)

logger = logging.getLogger(__name__)

MessageHandler = Callable[[aio_pika.abc.AbstractIncomingMessage], Awaitable[None]]


def build_order_events_handler(
    use_case: SendOrderNotification,
    deduplicator: InMemoryEventDeduplicator,
) -> MessageHandler:
    """Return a coroutine that routes a single order-outcome message.

    ``order.confirmed`` → confirmation email.
    ``order.rejected``  → rejection email (with the reason).
    Duplicate ``event_id`` (already seen) → ACK without resending.
    Unknown event_type  → NACK to the dead-letter queue.
    """

    async def handle(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        body = json.loads(message.body)
        event_type = body.get("event_type")
        event_id = body.get("event_id")

        if event_id is not None and deduplicator.seen(event_id):
            logger.info("duplicate order event %s — skipped", event_id)
            await message.ack()
            return

        if event_type == "order.confirmed":
            confirmed = OrderConfirmed.model_validate(body)
            use_case.execute(map_order_confirmed_to_params(confirmed))

        elif event_type == "order.rejected":
            rejected = OrderRejected.model_validate(body)
            use_case.execute(map_order_rejected_to_params(rejected))

        else:
            logger.warning("unknown event_type '%s' — dead-lettering message", event_type)
            await message.nack(requeue=False)
            return

        if event_id is not None:
            deduplicator.mark_seen(event_id)
        await message.ack()

    return handle
