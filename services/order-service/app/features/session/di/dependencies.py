from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config.env_config import EnvConfig
from app.core.exceptions.exceptions import UnauthorizedError
from app.core.providers.env_config import get_env_config
from app.features.session.application.contracts.token_issuer import TokenIssuer
from app.features.session.application.contracts.token_verifier import TokenVerifier
from app.features.session.application.usecases.create_session_use_case import CreateSession
from app.features.session.infrastructure.jwt_token_issuer import JwtTokenIssuer
from app.features.session.infrastructure.jwt_token_verifier import (
    INVALID_TOKEN_MESSAGE,
    JwtTokenVerifier,
)

# auto_error=False: with a missing header the error FastAPI raises on its own
# is 403 or 401 depending on the version; ours is always the 401 with
# WWW-Authenticate. The scheme still lands in OpenAPI, so Swagger shows
# "Authorize".
bearer_scheme = HTTPBearer(auto_error=False, description="Session token from POST /v1/session")


def get_token_issuer(config: Annotated[EnvConfig, Depends(get_env_config)]) -> TokenIssuer:
    return JwtTokenIssuer(config.auth_token_secret.get_secret_value())


def get_token_verifier(config: Annotated[EnvConfig, Depends(get_env_config)]) -> TokenVerifier:
    return JwtTokenVerifier(config.auth_token_secret.get_secret_value())


def get_create_session_use_case(
    token_issuer: Annotated[TokenIssuer, Depends(get_token_issuer)],
) -> CreateSession:
    return CreateSession(token_issuer=token_issuer)


def get_current_customer(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    verifier: Annotated[TokenVerifier, Depends(get_token_verifier)],
) -> str:
    """The customer id of the bearer token, or 401.

    The verifier checks the signature, the claims and the shape of the `sub`;
    this only reads the header and hands the token over.
    """
    if credentials is None:
        raise UnauthorizedError(INVALID_TOKEN_MESSAGE)
    return verifier.verify(credentials.credentials)


CurrentCustomer = Annotated[str, Depends(get_current_customer)]
