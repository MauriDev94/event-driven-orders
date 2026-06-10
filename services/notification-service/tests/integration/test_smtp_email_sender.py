"""Integration tests for the SMTP EmailSender adapter.

``smtplib.SMTP`` is mocked — we never open a real socket or hit Mailhog. We
assert the adapter builds the message correctly and maps transport failures to
``NotificationError``.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.core.exceptions.exceptions import NotificationError
from app.features.notifications.domain.entities.notification import Notification
from app.features.notifications.infrastructure.email.smtp_email_sender import SmtpEmailSender

pytestmark = pytest.mark.integration


def _notification() -> Notification:
    return Notification(
        recipient="customer@example.com",
        subject="Your order order-1 is confirmed",
        body="Good news!",
    )


@patch("app.features.notifications.infrastructure.email.smtp_email_sender.smtplib.SMTP")
def test_should_send_message_via_smtp(smtp_cls: MagicMock) -> None:
    smtp_instance = smtp_cls.return_value.__enter__.return_value
    sender = SmtpEmailSender(host="localhost", port=1025, sender_email="no-reply@local")

    sender.send(_notification())

    smtp_cls.assert_called_once_with("localhost", 1025, timeout=5)
    smtp_instance.send_message.assert_called_once()
    sent_message = smtp_instance.send_message.call_args.args[0]
    assert sent_message["To"] == "customer@example.com"
    assert sent_message["From"] == "no-reply@local"
    assert sent_message["Subject"] == "Your order order-1 is confirmed"


@patch("app.features.notifications.infrastructure.email.smtp_email_sender.smtplib.SMTP")
def test_should_raise_notification_error_on_transport_failure(smtp_cls: MagicMock) -> None:
    smtp_cls.side_effect = OSError("connection refused")
    sender = SmtpEmailSender(host="localhost", port=1025, sender_email="no-reply@local")

    with pytest.raises(NotificationError):
        sender.send(_notification())
