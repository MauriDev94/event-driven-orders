"""Integration tests for the notifications DI wiring (composition root)."""

import pytest

from app.features.notifications.application.contracts.email_sender import EmailSender
from app.features.notifications.application.usecases.send_order_notification_use_case import (
    SendOrderNotification,
)
from app.features.notifications.di.dependencies import (
    get_email_sender,
    get_send_order_notification_use_case,
)
from app.features.notifications.infrastructure.email.smtp_email_sender import SmtpEmailSender

pytestmark = pytest.mark.integration


def test_get_email_sender_returns_smtp_adapter() -> None:
    sender = get_email_sender()
    assert isinstance(sender, EmailSender)
    assert isinstance(sender, SmtpEmailSender)


def test_get_use_case_is_wired_with_email_sender() -> None:
    use_case = get_send_order_notification_use_case()
    assert isinstance(use_case, SendOrderNotification)
    assert isinstance(use_case.email_sender, EmailSender)
