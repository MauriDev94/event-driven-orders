from abc import ABC, abstractmethod

from app.features.notifications.domain.entities.notification import Notification


class EmailSender(ABC):
    """Outbound email port. Implemented in infrastructure (SMTP/Mailhog)."""

    @abstractmethod
    def send(self, notification: Notification) -> None:
        """Deliver a notification by email. Raises NotificationError on failure."""
        ...
