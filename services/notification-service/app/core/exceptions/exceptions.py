class AppError(Exception):
    """Base class for domain/application errors."""


class ValidationError(AppError):
    """Mapped to HTTP 422."""


class NotificationError(AppError):
    """Raised when an email could not be delivered. Mapped to HTTP 500."""
