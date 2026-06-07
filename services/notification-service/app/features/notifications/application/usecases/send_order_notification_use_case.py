from dataclasses import dataclass

from app.common.use_case import UseCase
from app.features.notifications.application.contracts.email_sender import EmailSender


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

    SCAFFOLD STUB: the EmailSender port is injected; the body composition and
    delivery land in Phase 4.
    """

    def __init__(self, email_sender: EmailSender) -> None:
        self.email_sender = email_sender

    def execute(self, params: SendOrderNotificationParams) -> SendOrderNotificationResult:
        raise NotImplementedError("SendOrderNotification is implemented in Phase 4")
