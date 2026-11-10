import pytest

pytestmark = pytest.mark.integration

_VALID_BODY = {
    "lines": [{"product_id": "p1", "quantity": 2, "unit_price": "10.00"}],
}


def _as(make_token, customer_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(sub=customer_id)}"}


def test_should_return_200_with_the_order_to_its_owner(
    api_client, auth_headers, customer_id
) -> None:
    created = api_client.post("/v1/orders", json=_VALID_BODY, headers=auth_headers).json()

    response = api_client.get(f"/v1/orders/{created['id']}", headers=auth_headers)

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == created["id"]
    assert body["customer_id"] == customer_id
    assert body["total_amount"] == "20.00"


def test_should_return_404_when_the_order_does_not_exist(api_client, auth_headers) -> None:
    response = api_client.get("/v1/orders/does-not-exist", headers=auth_headers)

    assert response.status_code == 404


def test_should_return_404_for_an_order_of_another_customer(
    api_client, auth_headers, make_token
) -> None:
    created = api_client.post("/v1/orders", json=_VALID_BODY, headers=auth_headers).json()

    response = api_client.get(f"/v1/orders/{created['id']}", headers=_as(make_token, "customer-2"))

    assert response.status_code == 404


def test_should_answer_a_foreign_order_exactly_like_a_missing_one(
    api_client, auth_headers, make_token
) -> None:
    created = api_client.post("/v1/orders", json=_VALID_BODY, headers=auth_headers).json()
    other = _as(make_token, "customer-2")

    foreign = api_client.get(f"/v1/orders/{created['id']}", headers=other)
    missing = api_client.get("/v1/orders/00000000-0000-0000-0000-000000000000", headers=other)

    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()
    assert foreign.headers["content-type"] == missing.headers["content-type"]
