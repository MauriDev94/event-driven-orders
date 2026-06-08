import smtplib
from email.message import EmailMessage

from app.core.exceptions.exceptions import NotificationError
from app.features.notifications.application.contracts.email_sender import EmailSender
from app.features.notifications.domain.entities.notification import Notification


class SmtpEmailSender(EmailSender):
    """SMTP implementation of the EmailSender port.

    Targets Mailhog locally (no auth, plain SMTP). Uses the stdlib ``smtplib``
    so no extra dependency is required.
    """

    def __init__(self, host: str, port: int, sender_email: str) -> None:
        self._host = host
        self._port = port
        self._sender_email = sender_email

    def send(self, notification: Notification) -> None:
        message = EmailMessage()
        message["From"] = self._sender_email
        message["To"] = notification.recipient
        message["Subject"] = notification.subject
        message.set_content(notification.body)
        try:
            with smtplib.SMTP(self._host, self._port, timeout=5) as smtp:
                smtp.send_message(message)
        except OSError as exc:  # connection / send failures
            raise NotificationError("failed to send email") from exc
