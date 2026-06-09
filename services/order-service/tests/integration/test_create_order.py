import pytest
from shared.contracts.order_events import OrderCreated

from app.features.orders.infrastructure.models.order_model import OrderModel

pytestmark = pytest.mark.integration

_VALID_BODY = {
    "customer_id": "customer-1",
    "lines": [
        {"product_id": "p1", "quantity": 2, "unit_price": "10.00"},
        {"product_id": "p2", "quantity": 1, "unit_price": "5.50"},
    ],
}


def test_should_return_201_with_a_pending_order_when_creating(api_client) -> None:
    response = api_client.post("/v1/orders", json=_VALID_BODY)

    assert response.status_code == 201
    body = response.json()
    assert body["id"]
    assert body["status"] == "pending"
    assert body["customer_id"] == "customer-1"


def test_should_persist_the_order_when_creating(api_client, session_factory) -> None:
    api_client.post("/v1/orders", json=_VALID_BODY)

    session = session_factory()
    try:
        orders = session.query(OrderModel).all()
        assert len(orders) == 1
        assert len(orders[0].lines) == 2
    finally:
        session.close()


def test_should_publish_order_created_when_creating(api_client, spy_publisher) -> None:
    response = api_client.post("/v1/orders", json=_VALID_BODY)

    order_id = response.json()["id"]
    assert len(spy_publisher.calls) == 1
    event, routing_key = spy_publisher.calls[0]
    assert isinstance(event, OrderCreated)
    assert routing_key == "order.created"
    assert event.order_id == order_id
    assert event.correlation_id == order_id


def test_should_return_422_when_the_order_has_no_lines(api_client) -> None:
    response = api_client.post("/v1/orders", json={"customer_id": "c1", "lines": []})

    assert response.status_code == 422
