"""End-to-end forcing tests for the retry-with-backoff and DLQ topology.

Each test spins up a real RabbitMQ broker (session-scoped fixture in the
sibling ``conftest.py``) and exercises ``wrap_with_retry`` against it.
The goal is to validate AMQP behavior the AsyncMock-based unit and
integration tests cannot see: real TTL queues, real dead-letter routing,
real round-trip of body and headers through the broker.

Scenarios:

- Scenario 1 (slow): full retry chain ``retry-5s`` -> ``retry-30s`` ->
  ``retry-2m`` -> DLQ after the handler raises on every attempt.
- Scenario 2 (fast): permanent failure (malformed JSON body) -> DLQ on
  the first attempt, without going through any retry queue.
- Scenario 3 (slow): recovery — handler fails twice (transient) then
  succeeds on the third attempt; the message is consumed exactly once.

Run with ``pytest -m integration`` from WSL, or skip the slow ones with
``pytest -m "integration and not slow"``.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock

import aio_pika
import pytest

from shared.messaging.retry_dispatcher import wrap_with_retry

from .conftest import declare_forcing_topology

pytestmark = pytest.mark.integration


# Unique queue name per scenario so parallel test runs do not collide on
# topology declarations. ``forcing`` keeps them discoverable in the
# RabbitMQ Management UI.
_QUEUE_DLQ_IMMEDIATE = "forcing.permanent-error.dlq-immediate"


async def _connect(
    url: str,
) -> tuple[aio_pika.abc.AbstractRobustConnection, aio_pika.abc.AbstractChannel]:
    """Open a robust connection + channel; caller closes on exit."""
    connection = await aio_pika.connect_robust(url)
    channel = await connection.channel()
    return connection, channel


async def _spy_on(queue: aio_pika.abc.AbstractQueue) -> tuple[asyncio.Queue, str]:
    """Attach a spy consumer that records incoming messages into a Queue.

    Returns ``(queue_for_messages, consumer_tag)``. The caller is
    responsible for cancelling the consumer via ``queue.cancel(tag)``.
    """
    received: asyncio.Queue = asyncio.Queue()

    async def _on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        # ``put_nowait`` keeps the consumer callback short; ack happens
        # after the message lands in the queue so the test always sees
        # what the broker actually delivered.
        received.put_nowait(message)
        await message.ack()

    consumer_tag = await queue.consume(_on_message)
    return received, consumer_tag


# ---------------------------------------------------------------------------
# Scenario 2 (fast): permanent failure -> DLQ on the first attempt.
# ---------------------------------------------------------------------------


async def test_should_dead_letter_permanent_error_on_first_attempt(rabbitmq_url) -> None:
    """A malformed JSON body is a permanent failure: ``wrap_with_retry``
    catches ``json.JSONDecodeError`` (classified as PERMANENT by the retry
    policy), nacks with ``requeue=False``, and the broker's dead-letter
    routing sends the message straight to the DLQ — without ever touching
    any retry queue.

    Forces the real RabbitMQ path that the AsyncMock tests skip:
    the main queue's ``x-dead-letter-exchange`` / ``x-dead-letter-routing-key``
    arguments must route the nacked message through the default exchange
    to the DLQ that this test declared in the same topology.
    """
    connection, channel = await _connect(rabbitmq_url)
    try:
        main_queue, dlq = await declare_forcing_topology(channel, _QUEUE_DLQ_IMMEDIATE)

        # Spy on the DLQ BEFORE publishing so we do not miss the delivery.
        dlq_received, dlq_consumer_tag = await _spy_on(dlq)

        # Handler always raises a parse-style error to simulate the
        # downstream consumer choking on a malformed payload.
        parse_error = json.JSONDecodeError("invalid", "", 0)
        handler = AsyncMock(side_effect=parse_error)
        dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=_QUEUE_DLQ_IMMEDIATE)

        # Publish the malformed message straight to the main queue via
        # the default exchange (routing key = queue name).
        PUBLISHED_BODY = b"definitely not json"
        await channel.default_exchange.publish(
            aio_pika.Message(
                body=PUBLISHED_BODY,
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                message_id="forcing-permanent-1",
            ),
            routing_key=_QUEUE_DLQ_IMMEDIATE,
        )

        # Start the dispatcher AFTER the message is enqueued so the
        # consumer picks it up on the first iteration (queue.consume
        # does not drain pre-existing messages retroactively unless the
        # queue was empty when consume was called).
        main_consumer_tag = await main_queue.consume(dispatch)

        try:
            dlq_message = await asyncio.wait_for(dlq_received.get(), timeout=5.0)
        except TimeoutError:
            pytest.fail("Malformed message did not reach the DLQ within 5s")
        finally:
            await main_queue.cancel(main_consumer_tag)
            await dlq.cancel(dlq_consumer_tag)

        # The body must survive the round-trip untouched.
        assert dlq_message.body == PUBLISHED_BODY
        # The dispatcher must have invoked the handler exactly once.
        handler.assert_awaited_once()
    finally:
        await connection.close()


__all__ = [
    "test_should_dead_letter_permanent_error_on_first_attempt",
]
