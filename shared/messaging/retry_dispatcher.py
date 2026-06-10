"""Retry/DLQ dispatcher: wraps a message handler with resilience.

``wrap_with_retry`` is the piece registered with ``queue.consume`` instead of
the bare handler. On success it is a transparent passthrough — the handler
keeps owning its own ack. On failure it:

- Reads ``x-retry-count`` from the message headers (default 0).
- Classifies the exception (transient vs permanent) and asks
  ``retry_policy.decide_retry`` what to do.
- TRANSIENT, retries left: republishes the message body+headers (with
  ``x-retry-count`` incremented) to the matching ``<queue>.<retry-stage>``
  queue via the default exchange, then ACKs the original — the retry
  queue's TTL + dead-letter-exchange brings it back to the main queue.
- PERMANENT or retries exhausted: NACKs without requeue, sending the
  message straight to the queue's dead-letter queue.
"""

import logging
from collections.abc import Awaitable, Callable

import aio_pika

from shared.messaging.retry_policy import (
    RETRY_COUNT_HEADER,
    RetryAction,
    classify_exception,
    decide_retry,
)

logger = logging.getLogger(__name__)

MessageHandler = Callable[[aio_pika.abc.AbstractIncomingMessage], Awaitable[None]]


def wrap_with_retry(
    handler: MessageHandler,
    *,
    channel: aio_pika.abc.AbstractChannel,
    main_queue_name: str,
) -> MessageHandler:
    """Return a handler that adds retry-with-backoff and DLQ semantics."""

    async def dispatch(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        try:
            await handler(message)
        except Exception as exc:  # noqa: BLE001 - classified below
            headers = dict(message.headers or {})
            retry_count = int(headers.get(RETRY_COUNT_HEADER, 0))
            decision = decide_retry(retry_count, classify_exception(exc))

            if decision.action is RetryAction.DEAD_LETTER:
                logger.warning(
                    "dead-lettering message on queue '%s' after %d retries: %s",
                    main_queue_name,
                    retry_count,
                    exc,
                )
                await message.nack(requeue=False)
                return

            headers[RETRY_COUNT_HEADER] = decision.next_retry_count
            retry_queue = f"{main_queue_name}.{decision.retry_queue_suffix}"
            logger.warning(
                "retrying message on queue '%s' via '%s' (attempt %d): %s",
                main_queue_name,
                retry_queue,
                decision.next_retry_count,
                exc,
            )
            retry_message = aio_pika.Message(
                body=message.body,
                headers=headers,
                content_type=message.content_type,
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                message_id=message.message_id,
                correlation_id=message.correlation_id,
                type=message.type,
            )
            await channel.default_exchange.publish(
                retry_message, routing_key=retry_queue
            )
            await message.ack()

    return dispatch
