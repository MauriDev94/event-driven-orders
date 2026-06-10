"""Integration test: retry-with-backoff and DLQ for the order-events
consumer, end to end through ``wrap_with_retry``.

Same pattern as order-service's ``test_inventory_results_retry_dlq.py`` and
inventory-service's ``test_order_created_retry_dlq.py``: AsyncMock
channel/message, no real RabbitMQ. A fake ``SendOrderNotification`` use case
raises to simulate a transient failure (e.g. an SMTP outage).
"""

from unittest.mock import AsyncMock

import pytest
from shared.contracts.order_events import OrderConfirmed
from shared.messaging.retry_dispatcher import wrap_with_retry
from shared.messaging.retry_policy import RETRY_COUNT_HEADER, RETRY_STAGES

from app.core.messaging.topology import ORDER_OUTCOMES_QUEUE
from app.features.notifications.infrastructure.dedup.in_memory_event_deduplicator import (
    InMemoryEventDeduplicator,
)
from app.features.notifications.presentation.consumers.order_events_consumer import (
    build_order_events_handler,
)

pytestmark = pytest.mark.integration


def _fake_message(body: bytes, headers: dict | None = None) -> AsyncMock:
    msg = AsyncMock()
    msg.body = body
    msg.headers = headers
    msg.content_type = "application/json"
    msg.correlation_id = "corr-1"
    msg.message_id = "evt-1"
    msg.type = "order.confirmed"
    return msg


def _fake_channel() -> AsyncMock:
    channel = AsyncMock()
    channel.default_exchange = AsyncMock()
    return channel


def _order_confirmed_body(order_id: str = "order-1") -> bytes:
    event = OrderConfirmed(order_id=order_id, customer_id="customer-1", correlation_id=order_id)
    return event.model_dump_json().encode()


class _FailingSendOrderNotification:
    """Stands in for SendOrderNotification; always raises (simulates SMTP outage)."""

    def execute(self, params):
        raise RuntimeError("smtp connection refused")


async def test_should_dead_letter_after_retries_exhausted() -> None:
    handler = build_order_events_handler(
        _FailingSendOrderNotification(),  # type: ignore[arg-type]
        InMemoryEventDeduplicator(),
    )
    channel = _fake_channel()
    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=ORDER_OUTCOMES_QUEUE)
    body = _order_confirmed_body()

    message = _fake_message(body, headers={RETRY_COUNT_HEADER: len(RETRY_STAGES)})
    await dispatch(message)

    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_awaited_once_with(requeue=False)
    message.ack.assert_not_awaited()


async def test_should_republish_to_first_retry_queue_on_first_failure() -> None:
    handler = build_order_events_handler(
        _FailingSendOrderNotification(),  # type: ignore[arg-type]
        InMemoryEventDeduplicator(),
    )
    channel = _fake_channel()
    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=ORDER_OUTCOMES_QUEUE)
    body = _order_confirmed_body()

    message = _fake_message(body, headers={})
    await dispatch(message)

    channel.default_exchange.publish.assert_awaited_once()
    republished, kwargs = channel.default_exchange.publish.call_args
    assert kwargs["routing_key"] == f"{ORDER_OUTCOMES_QUEUE}.{RETRY_STAGES[0][0]}"
    assert republished[0].headers[RETRY_COUNT_HEADER] == 1
    message.ack.assert_awaited_once()


async def test_should_dead_letter_malformed_message_immediately() -> None:
    handler = build_order_events_handler(AsyncMock(), InMemoryEventDeduplicator())
    channel = _fake_channel()
    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=ORDER_OUTCOMES_QUEUE)

    message = _fake_message(b"not json", headers={RETRY_COUNT_HEADER: 0})
    await dispatch(message)

    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_awaited_once_with(requeue=False)


async def test_should_dead_letter_unknown_event_type_immediately() -> None:
    handler = build_order_events_handler(AsyncMock(), InMemoryEventDeduplicator())
    channel = _fake_channel()
    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=ORDER_OUTCOMES_QUEUE)

    message = _fake_message(
        b'{"event_type": "order.shipped", "order_id": "o1", "correlation_id": "o1"}',
        headers={RETRY_COUNT_HEADER: 0},
    )
    await dispatch(message)

    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_awaited_once_with(requeue=False)
