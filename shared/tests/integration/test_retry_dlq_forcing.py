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
from shared.messaging.retry_policy import MAX_RETRIES, RETRY_COUNT_HEADER, RETRY_STAGES

from .conftest import declare_forcing_topology

pytestmark = pytest.mark.integration


# Unique queue name per scenario so parallel test runs do not collide on
# topology declarations. ``forcing`` keeps them discoverable in the
# RabbitMQ Management UI.
_QUEUE_DLQ_IMMEDIATE = "forcing.permanent-error.dlq-immediate"
_QUEUE_FULL_CHAIN = "forcing.transient-exhausted.full-chain"
_QUEUE_RECOVERY = "forcing.transient-recovery.consume-once"


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


# ---------------------------------------------------------------------------
# Scenario 1 (slow, ~2m35s): full traversal retry-5s -> retry-30s ->
# retry-2m -> DLQ after the handler raises on every attempt.
# ---------------------------------------------------------------------------


@pytest.mark.slow
async def test_should_traverse_all_retry_stages_then_dead_letter(rabbitmq_url) -> None:
    """A handler that always raises forces the dispatcher to walk the
    backoff chain end to end:

        attempt 1 fails -> republish to ``<queue>.retry-5s`` (TTL 5s)
                         -> dead-letter back to main -> attempt 2
        attempt 2 fails -> republish to ``<queue>.retry-30s`` (TTL 30s)
                         -> dead-letter back to main -> attempt 3
        attempt 3 fails -> republish to ``<queue>.retry-2m`` (TTL 120s)
                         -> dead-letter back to main -> attempt 4
        attempt 4 fails -> retries exhausted -> nack(requeue=False)
                         -> dead-letter to DLQ

    Validates that every retry queue's ``x-message-ttl`` actually elapses,
    every retry queue's ``x-dead-letter-routing-key`` points back at the
    main queue, and the final ``x-retry-count`` header on the DLQ message
    equals ``len(RETRY_STAGES)`` (the dispatcher increments it on every
    republish). AsyncMock tests can verify the routing decision but not the
    real TTL round-trip through the broker.
    """
    connection, channel = await _connect(rabbitmq_url)
    try:
        main_queue, dlq = await declare_forcing_topology(channel, _QUEUE_FULL_CHAIN)

        dlq_received, dlq_consumer_tag = await _spy_on(dlq)

        # Handler always raises a transient-style error: each attempt
        # fails, the dispatcher republishes to the next backoff stage.
        handler = AsyncMock(side_effect=RuntimeError("forced transient failure"))
        dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=_QUEUE_FULL_CHAIN)

        PUBLISHED_BODY = json.dumps({"order_id": "forcing-full-chain-1"}).encode()
        await channel.default_exchange.publish(
            aio_pika.Message(
                body=PUBLISHED_BODY,
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                message_id="forcing-full-chain-1",
            ),
            routing_key=_QUEUE_FULL_CHAIN,
        )

        main_consumer_tag = await main_queue.consume(dispatch)

        try:
            # Total wait = 5s + 30s + 120s = 155s, plus a small buffer
            # for the broker's bookkeeping on each handoff.
            dlq_message = await asyncio.wait_for(dlq_received.get(), timeout=180.0)
        except TimeoutError:
            pytest.fail("Message did not reach the DLQ within 180s of backoff traversal")
        finally:
            await main_queue.cancel(main_consumer_tag)
            await dlq.cancel(dlq_consumer_tag)

        # The handler must have been invoked for every attempt (initial +
        # every retry that bounced back via TTL dead-letter).
        assert handler.await_count == MAX_RETRIES + 1

        # The DLQ message body and ``x-retry-count`` header must reflect
        # the full traversal: the counter is incremented by the
        # dispatcher on every republish, so by the time the message
        # dead-letters for good it equals ``len(RETRY_STAGES)``.
        assert dlq_message.body == PUBLISHED_BODY
        assert dlq_message.headers[RETRY_COUNT_HEADER] == len(RETRY_STAGES)
        # Belt-and-braces: confirm the constants used in this test
        # match the ones the dispatcher walked.
        assert len(RETRY_STAGES) == 3
    finally:
        await connection.close()


# ---------------------------------------------------------------------------
# Scenario 3 (slow, ~35s): recovery - handler fails twice (transient) then
# succeeds on the third attempt; the message is consumed exactly once.
# ---------------------------------------------------------------------------


class _RecoveryHandler:
    """Async handler that raises on the first two calls and acks on the
    third. Used to simulate a transient failure that the system recovers
    from after the second retry.
    """

    def __init__(self) -> None:
        self.calls = 0
        self.success_body: bytes | None = None

    async def __call__(self, message: aio_pika.abc.AbstractIncomingMessage) -> None:
        self.calls += 1
        if self.calls <= 2:
            raise RuntimeError("forced transient failure (recovery test)")
        self.success_body = message.body
        await message.ack()


@pytest.mark.slow
async def test_should_consume_exactly_once_after_two_transient_failures(rabbitmq_url) -> None:
    """A transient failure that the system recovers from after the second
    retry. The dispatcher must:

    1. Republish to ``<queue>.retry-5s`` on the first failure (TTL 5s).
    2. Republish to ``<queue>.retry-30s`` on the second failure (TTL 30s).
    3. Pass the third delivery through to the handler, which acks it.

    The DLQ must remain empty: a successful consumption never dead-letters.
    AsyncMock tests can verify the routing decisions in isolation; this
    test verifies that a real broker actually delivers the recovered
    message exactly once, three times in a row.
    """
    connection, channel = await _connect(rabbitmq_url)
    try:
        main_queue, dlq = await declare_forcing_topology(channel, _QUEUE_RECOVERY)

        dlq_received, dlq_consumer_tag = await _spy_on(dlq)

        handler = _RecoveryHandler()
        dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=_QUEUE_RECOVERY)

        PUBLISHED_BODY = json.dumps({"order_id": "forcing-recovery-1"}).encode()
        await channel.default_exchange.publish(
            aio_pika.Message(
                body=PUBLISHED_BODY,
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                message_id="forcing-recovery-1",
            ),
            routing_key=_QUEUE_RECOVERY,
        )

        main_consumer_tag = await main_queue.consume(dispatch)

        try:
            # Wait long enough for both retry stages (5s + 30s) plus a
            # buffer for the broker's bookkeeping on each handoff and
            # the handler's third call. If anything reaches the DLQ the
            # test fails immediately; if the handler succeeds the DLQ
            # stays empty and we time out (which is the success path).
            try:
                unexpected_dlq_message = await asyncio.wait_for(dlq_received.get(), timeout=45.0)
            except TimeoutError:
                unexpected_dlq_message = None
            assert unexpected_dlq_message is None, (
                "Recovered message was incorrectly dead-lettered: "
                f"body={unexpected_dlq_message.body!r}"
            )

            # The handler must have seen the message three times: initial
            # delivery + retry-5s + retry-30s.
            assert handler.calls == 3, (
                f"Expected 3 handler invocations (initial + 2 retries), got {handler.calls}"
            )
            # The third (successful) call must carry the original body.
            assert handler.success_body == PUBLISHED_BODY
        finally:
            await main_queue.cancel(main_consumer_tag)
            await dlq.cancel(dlq_consumer_tag)
    finally:
        await connection.close()


__all__ = [
    "test_should_consume_exactly_once_after_two_transient_failures",
    "test_should_dead_letter_permanent_error_on_first_attempt",
    "test_should_traverse_all_retry_stages_then_dead_letter",
]
