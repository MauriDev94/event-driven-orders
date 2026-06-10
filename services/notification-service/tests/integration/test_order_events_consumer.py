"""Integration tests for the order-events consumer handler.

Invokes ``build_order_events_handler`` directly with fake aio_pika messages —
no RabbitMQ, no SMTP. The use case runs against a SPY EmailSender so the full
transport path is exercised: deserialize → map → use case → email (spy).

Mailhog is only used for the manual ``make up`` smoke test, never here.
"""

from unittest.mock import AsyncMock

import pytest
from shared.contracts.order_events import OrderConfirmed, OrderRejected

from app.features.notifications.application.usecases.send_order_notification_use_case import (
    SendOrderNotification,
)
from app.features.notifications.domain.entities.notification import Notification
from app.features.notifications.infrastructure.dedup.in_memory_event_deduplicator import (
    InMemoryEventDeduplicator,
)
from app.features.notifications.presentation.consumers.order_events_consumer import (
    build_order_events_handler,
)

pytestmark = pytest.mark.integration


class SpyEmailSender:
    def __init__(self) -> None:
        self.sent: list[Notification] = []

    def send(self, notification: Notification) -> None:
        self.sent.append(notification)


def _fake_message(event) -> AsyncMock:
    msg = AsyncMock()
    msg.body = event.model_dump_json().encode()
    return msg


def _build_handler(spy: SpyEmailSender, deduplicator: InMemoryEventDeduplicator | None = None):
    use_case = SendOrderNotification(email_sender=spy)  # type: ignore[arg-type]
    return build_order_events_handler(use_case, deduplicator or InMemoryEventDeduplicator())


# ---------------------------------------------------------------------------
# order.confirmed → confirmation email
# ---------------------------------------------------------------------------


async def test_should_send_confirmation_email_on_order_confirmed() -> None:
    spy = SpyEmailSender()
    handler = _build_handler(spy)
    event = OrderConfirmed(order_id="order-123", customer_id="cust-7", correlation_id="order-123")
    msg = _fake_message(event)

    await handler(msg)

    assert len(spy.sent) == 1
    notification = spy.sent[0]
    assert notification.recipient == "cust-7@example.com"
    assert "order-123" in notification.subject
    assert "confirm" in notification.subject.lower()
    msg.ack.assert_awaited_once()
    msg.nack.assert_not_awaited()


# ---------------------------------------------------------------------------
# order.rejected → rejection email (carries the reason)
# ---------------------------------------------------------------------------


async def test_should_send_rejection_email_on_order_rejected() -> None:
    spy = SpyEmailSender()
    handler = _build_handler(spy)
    event = OrderRejected(
        order_id="order-999",
        customer_id="cust-9",
        correlation_id="order-999",
        reason="insufficient stock for p1",
    )
    msg = _fake_message(event)

    await handler(msg)

    assert len(spy.sent) == 1
    notification = spy.sent[0]
    assert notification.recipient == "cust-9@example.com"
    assert "order-999" in notification.body
    assert "insufficient stock for p1" in notification.body
    msg.ack.assert_awaited_once()


# ---------------------------------------------------------------------------
# Unknown event_type → dead-letter (nack, requeue=False), no email
# ---------------------------------------------------------------------------


async def test_should_dead_letter_unknown_event_type() -> None:
    spy = SpyEmailSender()
    handler = _build_handler(spy)
    msg = AsyncMock()
    msg.body = b'{"event_type": "order.shipped", "order_id": "o1", "correlation_id": "o1"}'

    await handler(msg)

    assert spy.sent == []
    msg.nack.assert_awaited_once_with(requeue=False)
    msg.ack.assert_not_awaited()


# ---------------------------------------------------------------------------
# Idempotency: redelivery of an already-handled event_id
# ---------------------------------------------------------------------------


async def test_should_not_resend_email_on_duplicate_order_confirmed_event() -> None:
    """A redelivered OrderConfirmed (same event_id, e.g. after a transient
    retry) must ACK without sending a second email."""
    spy = SpyEmailSender()
    dedup = InMemoryEventDeduplicator()
    handler = _build_handler(spy, dedup)
    event = OrderConfirmed(order_id="order-123", customer_id="cust-7", correlation_id="order-123")

    await handler(_fake_message(event))
    assert len(spy.sent) == 1

    dup_msg = _fake_message(event)
    await handler(dup_msg)

    assert len(spy.sent) == 1
    dup_msg.ack.assert_awaited_once()
    dup_msg.nack.assert_not_awaited()
