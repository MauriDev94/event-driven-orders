import pytest

pytestmark = pytest.mark.integration

_VALID_BODY = {
    "customer_id": "customer-1",
    "lines": [{"product_id": "p1", "quantity": 2, "unit_price": "10.00"}],
}


def test_should_return_200_with_the_order_when_it_exists(api_client) -> None:
    created = api_client.post("/v1/orders", json=_VALID_BODY).json()

    response = api_client.get(f"/v1/orders/{created['id']}")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == created["id"]
    assert body["customer_id"] == "customer-1"
    assert body["total_amount"] == "20.00"


def test_should_return_404_when_the_order_does_not_exist(api_client) -> None:
    response = api_client.get("/v1/orders/does-not-exist")

    assert response.status_code == 404
