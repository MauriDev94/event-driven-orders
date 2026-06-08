import logging

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.core.exceptions.exceptions import (
    ConflictError,
    DatabaseError,
    NotFoundError,
    ValidationError,
)

logger = logging.getLogger(__name__)


async def not_found_handler(request: Request, exc: NotFoundError) -> JSONResponse:
    return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"message": str(exc)})


async def conflict_handler(request: Request, exc: ConflictError) -> JSONResponse:
    return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"message": str(exc)})


async def validation_handler(request: Request, exc: ValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content={"message": str(exc)}
    )


async def database_handler(request: Request, exc: DatabaseError) -> JSONResponse:
    logger.error("DatabaseError: %s", exc)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"message": "Database error occurred"},
    )


async def value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"message": str(exc) or "Validation error"},
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Register global exception handlers mapping domain errors to HTTP."""
    app.add_exception_handler(NotFoundError, not_found_handler)
    app.add_exception_handler(ConflictError, conflict_handler)
    app.add_exception_handler(ValidationError, validation_handler)
    app.add_exception_handler(DatabaseError, database_handler)
    app.add_exception_handler(ValueError, value_error_handler)
