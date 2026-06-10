"""Unit tests for the order-event → notification-params mapper.

The events carry ``customer_id`` (not an email): the MVP has no customer
directory, so the mapper derives a deterministic placeholder address. This is
a documented limitation (see README).
"""

import pytest
from shared.contracts.order_events import OrderConfirmed, OrderRejected

from app.features.notifications.application.mappers.order_event_mapper import (
    map_order_confirmed_to_params,
    map_order_rejected_to_params,
)

pytestmark = pytest.mark.unit


def test_should_map_order_confirmed_to_confirmation_params() -> None:
    event = OrderConfirmed(
        order_id="order-123",
        customer_id="cust-7",
        correlation_id="order-123",
    )

    params = map_order_confirmed_to_params(event)

    assert params.order_id == "order-123"
    assert params.outcome == "confirmed"
    assert params.reason is None
    assert params.customer_email == "cust-7@example.com"


def test_should_map_order_rejected_to_rejection_params_with_reason() -> None:
    event = OrderRejected(
        order_id="order-999",
        customer_id="cust-9",
        correlation_id="order-999",
        reason="insufficient stock for p1",
    )

    params = map_order_rejected_to_params(event)

    assert params.order_id == "order-999"
    assert params.outcome == "rejected"
    assert params.reason == "insufficient stock for p1"
    assert params.customer_email == "cust-9@example.com"
