import re

import jwt
import pytest

from app.common.identifiers import ID_MAX_LENGTH, ID_PATTERN
from app.features.session.domain.token_claims import AUDIENCE, ISSUER, TOKEN_TTL_SECONDS

pytestmark = pytest.mark.integration


def _claims(token: str, secret: str) -> dict:
    return jwt.decode(token, secret, algorithms=["HS256"], audience=AUDIENCE, issuer=ISSUER)


def test_should_return_a_bearer_token_when_opening_a_session(api_client) -> None:
    response = api_client.post("/v1/session")

    assert response.status_code == 201
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == TOKEN_TTL_SECONDS
    assert body["access_token"]


def test_should_not_cache_the_token_response(api_client) -> None:
    response = api_client.post("/v1/session")

    assert response.headers["Cache-Control"] == "no-store"


def test_should_use_a_customer_id_that_passes_the_order_validation(api_client, auth_secret) -> None:
    token = api_client.post("/v1/session").json()["access_token"]

    claims = _claims(token, auth_secret)

    assert re.match(ID_PATTERN, claims["sub"])
    assert len(claims["sub"]) <= ID_MAX_LENGTH
    assert claims["typ"] == "session"


def test_should_give_every_session_its_own_customer_id(api_client, auth_secret) -> None:
    def sub() -> str:
        return _claims(api_client.post("/v1/session").json()["access_token"], auth_secret)["sub"]

    assert sub() != sub()


def test_should_let_the_issued_token_create_and_read_an_order(api_client) -> None:
    token = api_client.post("/v1/session").json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    body = {"lines": [{"product_id": "p1", "quantity": 1, "unit_price": "10.00"}]}

    created = api_client.post("/v1/orders", json=body, headers=headers)
    fetched = api_client.get(f"/v1/orders/{created.json()['id']}", headers=headers)

    assert created.status_code == 201
    assert fetched.status_code == 200
    assert fetched.json()["customer_id"] == created.json()["customer_id"]
