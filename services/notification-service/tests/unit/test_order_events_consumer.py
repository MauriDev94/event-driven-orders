"""Unit tests for the order events consumer's logging behavior.

Reproduces issue #31: the consumer must emit a log on the happy path so the
correlation_id end-to-end trace works. The dispatcher
(``shared/messaging/retry_dispatcher.py``) already binds the correlation_id
from the event body into a structlog contextvar before invoking the handler;
this test verifies the handler emits a log entry that carries that contextvar
and the four event fields required by the issue acceptance criteria.

See ``test_correlation_id_middleware.py`` (order-service) for the canonical
``LogCapture + merge_contextvars`` pattern used here.
"""

import json
from unittest.mock import AsyncMock, Mock

import pytest
import structlog
from shared.contracts.order_events import OrderConfirmed
from shared.observability.context import bound_correlation_id

from app.features.notifications.infrastructure.dedup.in_memory_event_deduplicator import (
    InMemoryEventDeduplicator,
)
from app.features.notifications.presentation.consumers.order_events_consumer import (
    build_order_events_handler,
)

pytestmark = pytest.mark.unit


def _fake_message(body: dict) -> AsyncMock:
    """Build a fake aio_pika AbstractIncomingMessage carrying a JSON body."""
    msg = AsyncMock()
    msg.body = json.dumps(body).encode()
    return msg


def _confirmed(correlation_id: str = "trace-002", order_id: str = "order-2") -> dict:
    return OrderConfirmed(
        correlation_id=correlation_id,
        order_id=order_id,
        customer_id="customer-2",
    ).model_dump(mode="json")


async def test_should_log_event_received_with_correlation_id_on_confirmed_event() -> None:
    """Issue #31: handler must emit an "event received" log carrying correlation_id."""
    use_case = Mock()
    handler = build_order_events_handler(use_case, InMemoryEventDeduplicator())

    # capture_logs() alone drops merge_contextvars; wire a chain that keeps it.
    cap = structlog.testing.LogCapture()
    old_processors = structlog.get_config()["processors"]
    structlog.configure(processors=[structlog.contextvars.merge_contextvars, cap])
    try:
        # Mimic shared.messaging.retry_dispatcher: bind correlation_id before invoking.
        with bound_correlation_id("trace-test-002"):
            await handler(_fake_message(_confirmed(correlation_id="trace-test-002")))
    finally:
        structlog.configure(processors=old_processors)

    received = [e for e in cap.entries if e.get("event") == "event received"]
    assert len(received) == 1, (
        f"expected 1 'event received' log, got {len(received)}: {cap.entries}"
    )
    entry = received[0]
    assert entry["correlation_id"] == "trace-test-002"
    assert entry["event_type"] == "order.confirmed"
    assert entry["order_id"] == "order-2"
    assert entry["event_id"]
