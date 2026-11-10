import re

import jwt

from app.common.identifiers import ID_MAX_LENGTH, ID_PATTERN
from app.core.exceptions.exceptions import UnauthorizedError
from app.features.session.application.contracts.token_verifier import TokenVerifier
from app.features.session.domain.token_claims import (
    ALGORITHM,
    AUDIENCE,
    ISSUER,
    LEEWAY_SECONDS,
    TOKEN_TYPE,
)

# One message for every failure: it must not tell an attacker which check failed.
INVALID_TOKEN_MESSAGE = "Invalid or missing token"

_REQUIRED_CLAIMS = ["exp", "iat", "iss", "aud", "sub", "typ"]


class JwtTokenVerifier(TokenVerifier):
    """PyJWT adapter. The algorithm list is fixed, so ``alg: none`` and any
    other algorithm the token header asks for are rejected."""

    def __init__(self, secret: str) -> None:
        self._secret = secret

    def verify(self, token: str) -> str:
        try:
            claims = jwt.decode(
                token,
                self._secret,
                algorithms=[ALGORITHM],
                issuer=ISSUER,
                audience=AUDIENCE,
                leeway=LEEWAY_SECONDS,
                options={"require": _REQUIRED_CLAIMS},
            )
        except jwt.InvalidTokenError as exc:
            raise UnauthorizedError(INVALID_TOKEN_MESSAGE) from exc
        subject = claims["sub"]
        if claims["typ"] != TOKEN_TYPE or not _is_customer_id(subject):
            raise UnauthorizedError(INVALID_TOKEN_MESSAGE)
        return subject


def _is_customer_id(subject: object) -> bool:
    """The subject ends up in the database, in events and in an email address,
    so one that breaks the id rules is refused like a forged token."""
    return (
        isinstance(subject, str)
        and len(subject) <= ID_MAX_LENGTH
        and re.fullmatch(ID_PATTERN, subject) is not None
    )
