from app.core.providers.env_config import get_env_config
from app.features.notifications.application.contracts.email_sender import EmailSender
from app.features.notifications.application.usecases.send_order_notification_use_case import (
    SendOrderNotification,
)
from app.features.notifications.infrastructure.email.smtp_email_sender import SmtpEmailSender


def get_email_sender() -> EmailSender:
    """Provide the SMTP email sender (returns the port type)."""
    config = get_env_config()
    return SmtpEmailSender(
        host=config.smtp_host,
        port=config.smtp_port,
        sender_email=config.smtp_sender_email,
    )


def get_send_order_notification_use_case() -> SendOrderNotification:
    """Provide the SendOrderNotification use case."""
    return SendOrderNotification(email_sender=get_email_sender())
