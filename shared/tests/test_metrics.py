"""Unit tests for business metrics in shared/observability/metrics.py.

Verifies:
- Counter increments are visible immediately via the prometheus_client API.
- DLQ and retry counters are incremented by wrap_with_retry.

No real RabbitMQ is needed — same pattern as test_retry_dispatcher.py.
"""

from unittest.mock import AsyncMock

import pytest
from pydantic import BaseModel, ValidationError

from shared.messaging.retry_dispatcher import wrap_with_retry
from shared.messaging.retry_policy import RETRY_COUNT_HEADER, RETRY_STAGES
from shared.observability.metrics import (
    EVENTS_DLQ,
    EVENTS_PROCESSED,
    EVENTS_RETRIED,
    EVENT_PROCESSING_SECONDS,
)

pytestmark = pytest.mark.unit

MAIN_QUEUE = "test.metrics-queue"


def _fake_message(headers: dict | None = None, body: bytes = b'{"a": 1}') -> AsyncMock:
    msg = AsyncMock()
    msg.body = body
    msg.headers = headers
    msg.content_type = "application/json"
    msg.correlation_id = "corr-1"
    msg.message_id = "evt-1"
    msg.type = "test.event"
    return msg


def _fake_channel() -> AsyncMock:
    channel = AsyncMock()
    channel.default_exchange = AsyncMock()
    return channel


# ---------------------------------------------------------------------------
# Counter increment helpers
# ---------------------------------------------------------------------------


def _get_counter(counter, **labels) -> float:
    return counter.labels(**labels)._value.get()


def _get_histogram_count(histogram, **labels) -> float:
    labeled = histogram.labels(**labels)
    for sample in labeled._child_samples():
        if sample.name == "_count":
            return sample.value
    return 0.0


# ---------------------------------------------------------------------------
# EVENTS_DLQ — incremented on dead-letter path
# ---------------------------------------------------------------------------


async def test_should_increment_dlq_counter_when_retries_exhausted() -> None:
    handler = AsyncMock(side_effect=RuntimeError("db timeout"))
    channel = _fake_channel()
    message = _fake_message(headers={RETRY_COUNT_HEADER: len(RETRY_STAGES)})

    before = _get_counter(EVENTS_DLQ, queue=MAIN_QUEUE)

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    assert _get_counter(EVENTS_DLQ, queue=MAIN_QUEUE) == before + 1


class _Model(BaseModel):
    order_id: str


async def test_should_increment_dlq_counter_on_permanent_failure() -> None:
    try:
        _Model.model_validate({})
    except ValidationError as exc:
        handler = AsyncMock(side_effect=exc)

    channel = _fake_channel()
    message = _fake_message(headers={})

    before = _get_counter(EVENTS_DLQ, queue=MAIN_QUEUE)

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    assert _get_counter(EVENTS_DLQ, queue=MAIN_QUEUE) == before + 1


# ---------------------------------------------------------------------------
# EVENTS_RETRIED — incremented on transient-retry path
# ---------------------------------------------------------------------------


async def test_should_increment_retry_counter_on_transient_failure() -> None:
    handler = AsyncMock(side_effect=RuntimeError("db timeout"))
    channel = _fake_channel()
    message = _fake_message(headers={})

    before = _get_counter(EVENTS_RETRIED, queue=MAIN_QUEUE)

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    assert _get_counter(EVENTS_RETRIED, queue=MAIN_QUEUE) == before + 1


async def test_should_not_increment_retry_counter_on_success() -> None:
    handler = AsyncMock()
    channel = _fake_channel()
    message = _fake_message(headers={})

    before = _get_counter(EVENTS_RETRIED, queue=MAIN_QUEUE)

    dispatch = wrap_with_retry(handler, channel=channel, main_queue_name=MAIN_QUEUE)
    await dispatch(message)

    assert _get_counter(EVENTS_RETRIED, queue=MAIN_QUEUE) == before


# ---------------------------------------------------------------------------
# EVENTS_PROCESSED and EVENT_PROCESSING_SECONDS — direct counter API
# ---------------------------------------------------------------------------


def test_should_increment_events_processed_counter() -> None:
    before = _get_counter(EVENTS_PROCESSED, service="test-svc", event_type="test.event")
    EVENTS_PROCESSED.labels(service="test-svc", event_type="test.event").inc()
    assert (
        _get_counter(EVENTS_PROCESSED, service="test-svc", event_type="test.event")
        == before + 1
    )


def test_should_record_event_processing_histogram_observation() -> None:
    before = _get_histogram_count(EVENT_PROCESSING_SECONDS, service="test-svc")
    EVENT_PROCESSING_SECONDS.labels(service="test-svc").observe(0.042)
    assert (
        _get_histogram_count(EVENT_PROCESSING_SECONDS, service="test-svc") == before + 1
    )
