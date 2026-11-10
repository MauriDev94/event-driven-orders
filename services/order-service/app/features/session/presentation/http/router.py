from typing import Annotated

from fastapi import Depends, Response, status

from app.core.router.router import get_versioned_router
from app.features.session.application.usecases.create_session_use_case import CreateSession
from app.features.session.di.dependencies import get_create_session_use_case
from app.features.session.presentation.http.schemas.session_schemas import SessionResponse

router = get_versioned_router("v1")


@router.post(
    "/session",
    response_model=SessionResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["session"],
    summary="Open an anonymous session and get a bearer token",
)
def create_session(
    response: Response,
    use_case: Annotated[CreateSession, Depends(get_create_session_use_case)],
) -> SessionResponse:
    # The body carries a credential: RFC 6749 section 5.1.
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    issued = use_case.execute(None)
    return SessionResponse(access_token=issued.access_token, expires_in=issued.expires_in)
