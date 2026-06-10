"""Integration test: retry-with-backoff and DLQ for the inventory-results
consumer, end to end through ``wrap_with_retry``.

Uses an AsyncMock channel/message — no real RabbitMQ — following the same
pattern as ``test_topology.py`` and ``shared/tests/test_retry_dispatcher.py``.
A fake ``ConfirmOrder`` use case raises to simulate a transient failure (e.g.
a DB outage), letting us assert the full progression:

    attempt 1 fails -> republish to "<queue>.retry-5s" (x-retry-count=1)
    attempt 2 fails -> republish to "<queue>.retry-30s" (x-retry-count=2)
    attempt 3 fails -> republish to "<queue>.retry-2m" (x-retry-count=3)
    attempt 4 fails -> retries exhausted -> DLQ (nack, requeue=False)

A malformed message (bad JSON) is permanent and goes straight to the DLQ
regardless of ``x-retry-count``.
"""

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from shared.contracts.inventory_events import StockReserved
from shared.messaging.retry_dispatcher import wrap_with_retry
from shared.messaging.retry_policy import RETRY_COUNT_HEADER, RETRY_STAGES

from app.core.messaging.topology import ORDER_RESULTS_QUEUE
from app.features.orders.presentation.consumers.inventory_results_consumer import (
    build_inventory_result_handler,
)

pytestmark = pytest.mark.integration


def _fake_message(body: bytes, headers: dict | None = None) -> AsyncMock:
    msg = AsyncMock()
    msg.body = body
    msg.headers = headers
    msg.content_type = "application/json"
    msg.correlation_id = "corr-1"
    msg.message_id = "evt-1"
    msg.type = "stock.reserved"
    return msg


def _fake_channel() -> AsyncMock:
    channel = AsyncMock()
    channel.default_exchange = AsyncMock()
    return channel


def _stock_reserved_body(order_id: str = "order-1") -> bytes:
    event = StockReserved(order_id=order_id, event_id=str(uuid4()), correlation_id=order_id)
    return event.model_dump_json().encode()


class _FailingConfirmOrder:
    """Stands in for ConfirmOrder; always raises (simulates a DB outage)."""

    async def execute(self, params):
        raise RuntimeError("db connection refused")


async def test_should_progress_through_backoff_stages_then_dead_letter() -> None:
    handler = build_inventory_result_handler(_FailingConfirmOrder(), AsyncMock())  # type: ignore[arg-type]
    channel = _fake_channel()
    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=ORDER_RESULTS_QUEUE)
    body = _stock_reserved_body()

    # Attempts 1..MAX_RETRIES: each republishes to the next backoff stage.
    for attempt, (suffix, _ttl_ms) in enumerate(RETRY_STAGES, start=1):
        headers = {RETRY_COUNT_HEADER: attempt - 1} if attempt > 1 else {}
        message = _fake_message(body, headers=headers)

        await dispatch(message)

        channel.default_exchange.publish.assert_awaited_once()
        republished, kwargs = channel.default_exchange.publish.call_args
        assert kwargs["routing_key"] == f"{ORDER_RESULTS_QUEUE}.{suffix}"
        assert republished[0].headers[RETRY_COUNT_HEADER] == attempt
        message.ack.assert_awaited_once()
        message.nack.assert_not_awaited()
        channel.default_exchange.publish.reset_mock()

    # Final attempt: retries exhausted -> DLQ.
    message = _fake_message(body, headers={RETRY_COUNT_HEADER: len(RETRY_STAGES)})
    await dispatch(message)

    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_awaited_once_with(requeue=False)
    message.ack.assert_not_awaited()


async def test_should_dead_letter_malformed_message_immediately_regardless_of_retry_count() -> None:
    handler = build_inventory_result_handler(AsyncMock(), AsyncMock())
    channel = _fake_channel()
    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=ORDER_RESULTS_QUEUE)

    message = _fake_message(b"not json", headers={RETRY_COUNT_HEADER: 0})
    await dispatch(message)

    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_awaited_once_with(requeue=False)
