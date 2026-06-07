from dataclasses import dataclass
from enum import Enum


class NotificationChannel(str, Enum):
    EMAIL = "email"


@dataclass(slots=True)
class Notification:
    """A notification to be delivered to a customer about an order outcome.

    Pure domain object: holds the message and enforces that recipient and
    body are present. Delivery is an infrastructure concern (EmailSender).
    """

    recipient: str
    subject: str
    body: str
    channel: NotificationChannel = NotificationChannel.EMAIL

    def __post_init__(self) -> None:
        if not self.recipient.strip():
            raise ValueError("recipient cannot be empty")
        if not self.subject.strip():
            raise ValueError("subject cannot be empty")
        if not self.body.strip():
            raise ValueError("body cannot be empty")
