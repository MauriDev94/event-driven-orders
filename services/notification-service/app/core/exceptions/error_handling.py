import logging

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.core.exceptions.exceptions import NotificationError, ValidationError

logger = logging.getLogger(__name__)


async def validation_handler(request: Request, exc: ValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content={"message": str(exc)}
    )


async def notification_handler(request: Request, exc: NotificationError) -> JSONResponse:
    logger.error("NotificationError: %s", exc)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"message": "Notification delivery failed"},
    )


async def value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"message": str(exc) or "Validation error"},
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Register global exception handlers mapping domain errors to HTTP."""
    app.add_exception_handler(ValidationError, validation_handler)
    app.add_exception_handler(NotificationError, notification_handler)
    app.add_exception_handler(ValueError, value_error_handler)
