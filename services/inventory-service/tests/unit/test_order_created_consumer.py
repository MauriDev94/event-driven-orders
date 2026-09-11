"""Unit tests for the OrderCreated consumer's logging behavior.

Reproduces issue #31: the consumer must emit a log on the happy path so the
correlation_id end-to-end trace works. The dispatcher
(``shared/messaging/retry_dispatcher.py``) already binds the correlation_id
from the event body into a structlog contextvar before invoking the handler;
this test verifies the handler emits a log entry that carries that contextvar.

See ``test_correlation_id_middleware.py`` (order-service) for the canonical
``LogCapture + merge_contextvars`` pattern used here.
"""

from unittest.mock import AsyncMock

import pytest
import structlog
from shared.contracts.order_events import OrderCreated, OrderItem
from shared.observability.context import bound_correlation_id

from app.features.inventory.presentation.consumers.order_created_consumer import (
    build_order_created_handler,
)

pytestmark = pytest.mark.unit


def _fake_message(event: OrderCreated) -> AsyncMock:
    """Build a fake aio_pika AbstractIncomingMessage from an OrderCreated event."""
    msg = AsyncMock()
    msg.body = event.model_dump_json().encode()
    return msg


def _event(correlation_id: str = "trace-001", order_id: str = "order-1") -> OrderCreated:
    return OrderCreated(
        correlation_id=correlation_id,
        order_id=order_id,
        customer_id="customer-1",
        items=[OrderItem(product_id="SKU-A", quantity=2, unit_price="10.00")],
        total_amount="20.00",
    )


async def test_should_log_event_received_with_correlation_id_on_happy_path() -> None:
    """Issue #31: handler must emit an "event received" log carrying correlation_id."""
    use_case = AsyncMock()
    handler = build_order_created_handler(use_case)

    # capture_logs() alone drops merge_contextvars; wire a chain that keeps it.
    cap = structlog.testing.LogCapture()
    old_processors = structlog.get_config()["processors"]
    structlog.configure(processors=[structlog.contextvars.merge_contextvars, cap])
    try:
        # Mimic shared.messaging.retry_dispatcher: bind correlation_id before invoking.
        with bound_correlation_id("trace-test-001"):
            await handler(_fake_message(_event(correlation_id="trace-test-001")))
    finally:
        structlog.configure(processors=old_processors)

    received = [e for e in cap.entries if e.get("event") == "event received"]
    assert len(received) == 1, (
        f"expected 1 'event received' log, got {len(received)}: {cap.entries}"
    )
    entry = received[0]
    assert entry["correlation_id"] == "trace-test-001"
    assert entry["event_type"] == "order.created"
    assert entry["order_id"] == "order-1"
    assert entry["event_id"]
