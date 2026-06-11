"""Unit tests for ``wrap_with_retry`` — the per-message retry/DLQ dispatcher.

Uses ``AsyncMock`` for the aio-pika channel and message (same pattern as the
per-service ``test_topology.py`` files) — no real RabbitMQ needed. Verifies
routing (which queue a retried message is republished to), the
``x-retry-count`` header bookkeeping, and the dead-letter path.
"""

from unittest.mock import AsyncMock

import pytest
from pydantic import BaseModel, ValidationError

from shared.messaging.retry_dispatcher import wrap_with_retry
from shared.messaging.retry_policy import RETRY_COUNT_HEADER, RETRY_STAGES
from shared.observability.context import get_correlation_id

pytestmark = pytest.mark.unit

MAIN_QUEUE = "order-service.inventory-results"


def _fake_message(headers: dict | None = None, body: bytes = b'{"a": 1}') -> AsyncMock:
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


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


async def test_should_just_run_handler_on_success() -> None:
    handler = AsyncMock()
    channel = _fake_channel()
    message = _fake_message()

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    handler.assert_awaited_once_with(message)
    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_not_awaited()


# ---------------------------------------------------------------------------
# Transient failure -> retry
# ---------------------------------------------------------------------------


async def test_should_republish_to_first_retry_queue_on_first_transient_failure() -> (
    None
):
    handler = AsyncMock(side_effect=RuntimeError("db timeout"))
    channel = _fake_channel()
    message = _fake_message(headers={})

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    channel.default_exchange.publish.assert_awaited_once()
    published_message, kwargs = channel.default_exchange.publish.call_args
    routing_key = kwargs["routing_key"]
    assert routing_key == f"{MAIN_QUEUE}.{RETRY_STAGES[0][0]}"

    republished = published_message[0]
    assert republished.headers[RETRY_COUNT_HEADER] == 1
    assert republished.body == message.body

    message.ack.assert_awaited_once()
    message.nack.assert_not_awaited()


async def test_should_advance_to_next_retry_queue_using_existing_retry_count_header() -> (
    None
):
    handler = AsyncMock(side_effect=RuntimeError("db timeout"))
    channel = _fake_channel()
    message = _fake_message(headers={RETRY_COUNT_HEADER: 1})

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    _, kwargs = channel.default_exchange.publish.call_args
    assert kwargs["routing_key"] == f"{MAIN_QUEUE}.{RETRY_STAGES[1][0]}"

    republished = channel.default_exchange.publish.call_args[0][0]
    assert republished.headers[RETRY_COUNT_HEADER] == 2


async def test_should_preserve_other_headers_when_republishing() -> None:
    handler = AsyncMock(side_effect=RuntimeError("db timeout"))
    channel = _fake_channel()
    message = _fake_message(headers={"x-original-thing": "keep-me"})

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    republished = channel.default_exchange.publish.call_args[0][0]
    assert republished.headers["x-original-thing"] == "keep-me"
    assert republished.headers[RETRY_COUNT_HEADER] == 1


# ---------------------------------------------------------------------------
# Retries exhausted -> DLQ
# ---------------------------------------------------------------------------


async def test_should_dead_letter_when_retries_exhausted() -> None:
    handler = AsyncMock(side_effect=RuntimeError("db timeout"))
    channel = _fake_channel()
    message = _fake_message(headers={RETRY_COUNT_HEADER: len(RETRY_STAGES)})

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_awaited_once_with(requeue=False)
    message.ack.assert_not_awaited()


# ---------------------------------------------------------------------------
# Permanent failure -> DLQ regardless of retry count
# ---------------------------------------------------------------------------


class _Model(BaseModel):
    order_id: str


async def test_should_dead_letter_immediately_on_validation_error() -> None:
    try:
        _Model.model_validate({})
    except ValidationError as exc:
        handler = AsyncMock(side_effect=exc)

    channel = _fake_channel()
    message = _fake_message(headers={})

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_awaited_once_with(requeue=False)


async def test_should_dead_letter_immediately_on_unknown_event_type_value_error() -> (
    None
):
    handler = AsyncMock(side_effect=ValueError("unknown event_type 'bogus'"))
    channel = _fake_channel()
    message = _fake_message(headers=None)

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    channel.default_exchange.publish.assert_not_awaited()
    message.nack.assert_awaited_once_with(requeue=False)


# ---------------------------------------------------------------------------
# Correlation id propagation (Fase 6)
# ---------------------------------------------------------------------------


async def test_should_bind_correlation_id_from_event_body_during_handler() -> None:
    captured: dict[str, str | None] = {}

    async def handler(message) -> None:
        captured["correlation_id"] = get_correlation_id()

    channel = _fake_channel()
    message = _fake_message(body=b'{"correlation_id": "corr-xyz"}')

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    assert captured["correlation_id"] == "corr-xyz"
    assert get_correlation_id() is None


async def test_should_not_fail_when_event_body_has_no_correlation_id() -> None:
    handler = AsyncMock()
    channel = _fake_channel()
    message = _fake_message()

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    handler.assert_awaited_once_with(message)
    assert get_correlation_id() is None
