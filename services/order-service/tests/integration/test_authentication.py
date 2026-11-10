"""``get_current_customer``: what the orders endpoints accept as identity."""

import secrets

import pytest

pytestmark = pytest.mark.integration

_BODY = {"lines": [{"product_id": "p1", "quantity": 1, "unit_price": "10.00"}]}


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _call(api_client, headers: dict[str, str], *, create: bool):
    if create:
        return api_client.post("/v1/orders", json=_BODY, headers=headers)
    return api_client.get("/v1/orders/any-id", headers=headers)


@pytest.fixture(params=[True, False], ids=["create", "get"])
def create(request) -> bool:
    return request.param


def _assert_unauthorized(response) -> None:
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
    assert "message" in response.json()


def test_should_return_401_without_a_token(api_client, create) -> None:
    _assert_unauthorized(_call(api_client, {}, create=create))


def test_should_return_401_with_a_non_bearer_scheme(api_client, create) -> None:
    _assert_unauthorized(_call(api_client, {"Authorization": "Basic abc"}, create=create))


def test_should_return_401_with_garbage_in_the_token(api_client, create) -> None:
    _assert_unauthorized(_call(api_client, _bearer("not-a-jwt"), create=create))


def test_should_return_401_when_the_signature_is_invalid(api_client, make_token, create) -> None:
    token = make_token(secret=secrets.token_urlsafe(32))

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_return_401_for_an_unsigned_token(api_client, make_token, create) -> None:
    token = make_token(algorithm="none")

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_return_401_for_another_hmac_algorithm(api_client, make_token, create) -> None:
    token = make_token(algorithm="HS512")

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_return_401_for_the_wrong_audience(api_client, make_token, create) -> None:
    token = make_token(audience="someone-else")

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_return_401_for_the_wrong_issuer(api_client, make_token, create) -> None:
    token = make_token(issuer="someone-else")

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_return_401_for_an_expired_token(api_client, make_token, create) -> None:
    token = make_token(expires_in=-120)

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_tolerate_a_clock_skew_of_a_few_seconds(api_client, make_token) -> None:
    token = make_token(expires_in=-10)

    response = api_client.get("/v1/orders/any-id", headers=_bearer(token))

    assert response.status_code == 404  # authenticated; the order just doesn't exist


def test_should_return_401_for_the_wrong_token_type(api_client, make_token, create) -> None:
    token = make_token(typ="refresh")

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


@pytest.mark.parametrize("claim", ["sub", "exp", "iat", "iss", "aud"])
def test_should_return_401_when_a_required_claim_is_missing(
    api_client, make_token, claim, create
) -> None:
    token = make_token(omit=(claim,))

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_return_401_when_the_type_claim_is_missing(api_client, make_token, create) -> None:
    token = make_token(typ=None)

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_return_401_when_the_subject_is_not_a_valid_customer_id(
    api_client, make_token, create
) -> None:
    token = make_token(sub="not valid; drop table")

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_not_reveal_why_the_token_was_rejected(api_client, make_token) -> None:
    bad_signature = _call(
        api_client, _bearer(make_token(secret=secrets.token_urlsafe(32))), create=False
    )
    expired = _call(api_client, _bearer(make_token(expires_in=-120)), create=False)

    assert bad_signature.json() == expired.json()


def test_should_declare_the_bearer_scheme_in_the_openapi_document(api_client) -> None:
    schema = api_client.get("/openapi.json").json()

    schemes = schema["components"]["securitySchemes"].values()
    assert any(s.get("type") == "http" and s.get("scheme") == "bearer" for s in schemes)


def test_should_return_401_when_the_subject_is_longer_than_a_customer_id(
    api_client, make_token, create
) -> None:
    token = make_token(sub="a" + secrets.token_hex(18))  # 37 characters

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_return_401_when_the_subject_is_not_a_string(api_client, make_token, create) -> None:
    token = make_token(sub=12345)

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))


def test_should_return_401_when_the_token_was_issued_in_the_future(
    api_client, make_token, create
) -> None:
    token = make_token(issued_in=120)  # beyond the 30 s of leeway

    _assert_unauthorized(_call(api_client, _bearer(token), create=create))
