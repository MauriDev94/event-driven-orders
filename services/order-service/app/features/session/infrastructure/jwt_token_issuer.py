import time

import jwt

from app.features.session.application.contracts.token_issuer import IssuedToken, TokenIssuer
from app.features.session.domain.token_claims import (
    ALGORITHM,
    AUDIENCE,
    ISSUER,
    TOKEN_TTL_SECONDS,
    TOKEN_TYPE,
)


class JwtTokenIssuer(TokenIssuer):
    """PyJWT adapter: HS256 token with the claims of ADR-0027."""

    def __init__(self, secret: str) -> None:
        self._secret = secret

    def issue(self, customer_id: str) -> IssuedToken:
        now = int(time.time())
        claims = {
            "iss": ISSUER,
            "aud": AUDIENCE,
            "sub": customer_id,
            "iat": now,
            "exp": now + TOKEN_TTL_SECONDS,
            "typ": TOKEN_TYPE,
        }
        token = jwt.encode(claims, self._secret, algorithm=ALGORITHM)
        return IssuedToken(access_token=token, expires_in=TOKEN_TTL_SECONDS)
