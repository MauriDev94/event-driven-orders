from dataclasses import dataclass

from app.common.use_case import UseCase
from app.features.notifications.application.contracts.email_sender import EmailSender
from app.features.notifications.domain.entities.notification import Notification

CONFIRMED = "confirmed"
REJECTED = "rejected"


@dataclass
class SendOrderNotificationParams:
    order_id: str
    customer_email: str
    outcome: str  # "confirmed" | "rejected"
    reason: str | None = None


@dataclass
class SendOrderNotificationResult:
    delivered: bool


class SendOrderNotification(UseCase[SendOrderNotificationParams, SendOrderNotificationResult]):
    """Build and send the order-outcome notification email.

    Orchestration only: it composes the customer-facing message from the order
    outcome and hands it to the ``EmailSender`` port. The transport detail
    (SMTP/Mailhog) lives in infrastructure — the use case never touches it.
    """

    def __init__(self, email_sender: EmailSender) -> None:
        self.email_sender = email_sender

    def execute(self, params: SendOrderNotificationParams) -> SendOrderNotificationResult:
        subject, body = self._compose(params)
        notification = Notification(
            recipient=params.customer_email,
            subject=subject,
            body=body,
        )
        self.email_sender.send(notification)
        return SendOrderNotificationResult(delivered=True)

    def _compose(self, params: SendOrderNotificationParams) -> tuple[str, str]:
        if params.outcome == CONFIRMED:
            subject = f"Your order {params.order_id} is confirmed"
            body = (
                f"Good news! Your order {params.order_id} has been confirmed "
                "and is now being processed.\n\nThank you for your purchase."
            )
            return subject, body

        if params.outcome == REJECTED:
            reason = params.reason or "no reason provided"
            subject = f"Your order {params.order_id} was rejected"
            body = (
                f"Unfortunately, your order {params.order_id} was rejected.\n"
                f"Reason: {reason}\n\nWe are sorry for the inconvenience."
            )
            return subject, body

        raise ValueError(f"unknown order outcome '{params.outcome}'")
