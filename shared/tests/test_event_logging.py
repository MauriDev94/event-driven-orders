"""Tests for the shared event-logging helpers.

The ``log_event_received`` helper centralizes the contract required by
issue #31: every consumer must emit an ``event received`` log with
``event_type``, ``event_id``, ``correlation_id`` and ``order_id``. This test
pins the contract so a future change to the helper's signature is caught.
"""

import structlog

from shared.contracts.order_events import OrderConfirmed
from shared.observability.event_logging import log_event_received


def test_log_event_received_emits_log_with_required_fields() -> None:
    event = OrderConfirmed(
        correlation_id="trace-x",
        order_id="order-x",
        customer_id="customer-x",
    )

    cap = structlog.testing.LogCapture()
    old_processors = structlog.get_config()["processors"]
    structlog.configure(processors=[structlog.contextvars.merge_contextvars, cap])
    try:
        log_event_received(structlog.get_logger("test.consumer"), event)
    finally:
        structlog.configure(processors=old_processors)

    received = [e for e in cap.entries if e.get("event") == "event received"]
    assert len(received) == 1, (
        f"expected 1 'event received' log, got {len(received)}: {cap.entries}"
    )
    entry = received[0]
    assert entry["event_type"] == "order.confirmed"
    assert entry["event_id"] == event.event_id
    assert entry["correlation_id"] == "trace-x"
    assert entry["order_id"] == "order-x"
