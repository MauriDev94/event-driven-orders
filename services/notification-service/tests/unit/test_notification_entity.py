import pytest

from app.features.notifications.domain.entities.notification import (
    Notification,
    NotificationChannel,
)

pytestmark = pytest.mark.unit


def test_should_default_to_email_channel() -> None:
    notification = Notification(
        recipient="customer@example.com",
        subject="Order confirmed",
        body="Your order is on its way.",
    )

    assert notification.channel is NotificationChannel.EMAIL


def test_should_raise_when_recipient_is_empty() -> None:
    with pytest.raises(ValueError):
        Notification(recipient="  ", subject="Subject", body="Body")


def test_should_raise_when_body_is_empty() -> None:
    with pytest.raises(ValueError):
        Notification(recipient="customer@example.com", subject="Subject", body="")
