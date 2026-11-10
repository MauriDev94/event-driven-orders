import secrets
import time

import jwt
import pytest

from app.features.session.domain.token_claims import (
    ALGORITHM,
    AUDIENCE,
    ISSUER,
    TOKEN_TTL_SECONDS,
    TOKEN_TYPE,
)
from app.features.session.infrastructure.jwt_token_issuer import JwtTokenIssuer

pytestmark = pytest.mark.unit


def _issuer(secret: str) -> JwtTokenIssuer:
    return JwtTokenIssuer(secret)


def _decode(token: str, secret: str) -> dict:
    return jwt.decode(token, secret, algorithms=[ALGORITHM], audience=AUDIENCE, issuer=ISSUER)


def test_should_sign_the_documented_claims() -> None:
    secret = secrets.token_urlsafe(32)

    issued = _issuer(secret).issue("customer-1")

    claims = _decode(issued.access_token, secret)
    assert claims["sub"] == "customer-1"
    assert claims["typ"] == TOKEN_TYPE == "session"
    assert claims["iss"] == ISSUER
    assert claims["aud"] == AUDIENCE
    assert claims["exp"] - claims["iat"] == TOKEN_TTL_SECONDS == 7 * 24 * 3600


def test_should_sign_with_hs256() -> None:
    secret = secrets.token_urlsafe(32)

    issued = _issuer(secret).issue("customer-1")

    assert jwt.get_unverified_header(issued.access_token)["alg"] == "HS256"


def test_should_report_the_lifetime_in_seconds() -> None:
    issued = _issuer(secrets.token_urlsafe(32)).issue("customer-1")

    assert issued.expires_in == TOKEN_TTL_SECONDS


def test_should_stamp_the_current_time() -> None:
    secret = secrets.token_urlsafe(32)
    before = int(time.time())

    claims = _decode(_issuer(secret).issue("customer-1").access_token, secret)

    assert before <= claims["iat"] <= int(time.time())
