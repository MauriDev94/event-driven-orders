"""Unit tests for the SendOrderNotification use case.

The use case is tested against a FAKE EmailSender (spy) — no SMTP, no Mailhog.
We assert the composed Notification: recipient, subject and body content
(order_id for both outcomes, plus the rejection reason for rejected orders).
"""

import pytest

from app.features.notifications.application.contracts.email_sender import EmailSender
from app.features.notifications.application.usecases.send_order_notification_use_case import (
    SendOrderNotification,
    SendOrderNotificationParams,
)
from app.features.notifications.domain.entities.notification import (
    Notification,
    NotificationChannel,
)

pytestmark = pytest.mark.unit


class SpyEmailSender(EmailSender):
    """Records the notifications it is asked to send (no real delivery)."""

    def __init__(self) -> None:
        self.sent: list[Notification] = []

    def send(self, notification: Notification) -> None:
        self.sent.append(notification)


# ---------------------------------------------------------------------------
# OrderConfirmed → confirmation email
# ---------------------------------------------------------------------------


def test_should_send_confirmation_email_for_confirmed_order() -> None:
    spy = SpyEmailSender()
    use_case = SendOrderNotification(email_sender=spy)
    params = SendOrderNotificationParams(
        order_id="order-123",
        customer_email="customer@example.com",
        outcome="confirmed",
    )

    result = use_case.execute(params)

    assert result.delivered is True
    assert len(spy.sent) == 1
    notification = spy.sent[0]
    assert notification.recipient == "customer@example.com"
    assert notification.channel is NotificationChannel.EMAIL
    assert "order-123" in notification.subject
    assert "confirm" in notification.subject.lower()
    assert "order-123" in notification.body
    assert "confirm" in notification.body.lower()


# ---------------------------------------------------------------------------
# OrderRejected → rejection email (must carry the reason)
# ---------------------------------------------------------------------------


def test_should_send_rejection_email_with_reason_for_rejected_order() -> None:
    spy = SpyEmailSender()
    use_case = SendOrderNotification(email_sender=spy)
    params = SendOrderNotificationParams(
        order_id="order-999",
        customer_email="buyer@example.com",
        outcome="rejected",
        reason="insufficient stock for p1",
    )

    result = use_case.execute(params)

    assert result.delivered is True
    assert len(spy.sent) == 1
    notification = spy.sent[0]
    assert notification.recipient == "buyer@example.com"
    assert "order-999" in notification.subject
    assert "reject" in notification.subject.lower()
    assert "order-999" in notification.body
    assert "insufficient stock for p1" in notification.body


def test_should_raise_for_unknown_outcome() -> None:
    spy = SpyEmailSender()
    use_case = SendOrderNotification(email_sender=spy)
    params = SendOrderNotificationParams(
        order_id="order-1",
        customer_email="x@example.com",
        outcome="pending",  # not a terminal outcome we notify about
    )

    with pytest.raises(ValueError):
        use_case.execute(params)

    assert spy.sent == []
