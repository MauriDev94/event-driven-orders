class AppError(Exception):
    """Base class for domain/application errors mapped to HTTP responses."""


class NotFoundError(AppError):
    """Mapped to HTTP 404."""


class ConflictError(AppError):
    """Mapped to HTTP 409."""


class ValidationError(AppError):
    """Mapped to HTTP 422."""


class DatabaseError(AppError):
    """Mapped to HTTP 500 for persistence failures."""
