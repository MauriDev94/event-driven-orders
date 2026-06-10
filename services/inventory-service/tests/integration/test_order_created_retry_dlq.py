"""Integration test: retry-with-backoff and DLQ for the order-created
consumer, end to end through ``wrap_with_retry``.

Same pattern as order-service's ``test_inventory_results_retry_dlq.py``:
AsyncMock channel/message, no real RabbitMQ. A fake ``ReserveStock`` use case
raises to simulate a transient failure (e.g. a DB outage).
"""

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from shared.contracts.order_events import OrderCreated, OrderItem
from shared.messaging.retry_dispatcher import wrap_with_retry
from shared.messaging.retry_policy import RETRY_COUNT_HEADER, RETRY_STAGES

from app.core.messaging.topology import ORDER_CREATED_QUEUE
from app.features.inventory.presentation.consumers.order_created_consumer import (
    build_order_created_handler,
)

pytestmark = pytest.mark.integration


def _fake_message(body: bytes, headers: dict | None = None) -> AsyncMock:
    msg = AsyncMock()
    msg.body = body
    msg.headers = headers
    msg.content_type = "application/json"
    msg.correlation_id = "corr-1"
    msg.message_id = "evt-1"
    msg.type = "order.created"
    return msg


def _fake_channel() -> AsyncMock:
    channel = AsyncMock()
    channel.default_exchange = AsyncMock()
    return channel


def _order_created_body(order_id: str = "order-1") -> bytes:
    event = OrderCreated(
        correlation_id=order_id,
        order_id=order_id,
        customer_id="customer-1",
        items=[OrderItem(product_id="SKU-A", quantity=1, unit_price="10.00")],
        total_amount="10.00",
        event_id=str(uuid4()),
    )
    return event.model_dump_json().encode()


class _FailingReserveStock:
    """Stands in for ReserveStock; always raises (simulates a DB outage)."""

    async def execute(self, params):
        raise RuntimeError("db connection refused")


async def test_should_dead_letter_after_retries_exhausted() -> None:
    handler = build_order_created_handler(_FailingReserveStock())  # type: ignore[arg-type]
    channel = _fake_channel()
    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=ORDER_CREATED_QUEUE)
    body = _order_created_body()

    message = _fake_message(body, headers={RETRY_COUNT_HEADER: len(RETRY_STAGES)})
    await dispatch(message)

    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_awaited_once_with(requeue=False)
    message.ack.assert_not_awaited()


async def test_should_republish_to_first_retry_queue_on_first_failure() -> None:
    handler = build_order_created_handler(_FailingReserveStock())  # type: ignore[arg-type]
    channel = _fake_channel()
    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=ORDER_CREATED_QUEUE)
    body = _order_created_body()

    message = _fake_message(body, headers={})
    await dispatch(message)

    channel.default_exchange.publish.assert_awaited_once()
    republished, kwargs = channel.default_exchange.publish.call_args
    assert kwargs["routing_key"] == f"{ORDER_CREATED_QUEUE}.{RETRY_STAGES[0][0]}"
    assert republished[0].headers[RETRY_COUNT_HEADER] == 1
    message.ack.assert_awaited_once()


async def test_should_dead_letter_malformed_message_immediately() -> None:
    handler = build_order_created_handler(AsyncMock())
    channel = _fake_channel()
    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=ORDER_CREATED_QUEUE)

    message = _fake_message(b"not json", headers={RETRY_COUNT_HEADER: 0})
    await dispatch(message)

    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_awaited_once_with(requeue=False)
