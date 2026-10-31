"""End-to-end tests for assistant-service's order timeline.

assistant-service projects the five order events into its own read model. A
POST to order-service starts the flow; the result is read only through
assistant-service's HTTP API, the same way a client of the assistant would.

Duplicates and dead-lettering aren't reachable from a public API, so they are
covered by the service's own integration tests against real Postgres and
RabbitMQ (``services/assistant-service/test/integration``).

Run with: `make e2e` (Docker required). Not part of CI (ADR-0017).
"""

import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest

pytestmark = pytest.mark.e2e

# Seeded by the inventory-service migration (SKU-001=100 .. SKU-005=5).
_SKU_WITH_STOCK = "SKU-001"
_SKU_LOW_STOCK = "SKU-005"


def _create_order(
    order_client: httpx.Client,
    customer_id: str,
    product_id: str,
    quantity: int,
    correlation_id: str,
) -> dict[str, Any]:
    response = order_client.post(
        "/v1/orders",
        json={
            "customer_id": customer_id,
            "lines": [{"product_id": product_id, "quantity": quantity, "unit_price": "10.00"}],
        },
        headers={"X-Correlation-ID": correlation_id},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _timeline(assistant_client: httpx.Client, order_id: str) -> dict[str, Any] | None:
    response = assistant_client.get(f"/v1/assistant/orders/{order_id}/timeline")
    if response.status_code == 404:
        return None
    response.raise_for_status()
    return response.json()


def _event_types(timeline: dict[str, Any] | None) -> list[str]:
    return [] if timeline is None else [e["event_type"] for e in timeline["events"]]


def _wait_for_events(
    assistant_client: httpx.Client,
    order_id: str,
    expected: list[str],
    wait_until: Callable[..., None],
) -> dict[str, Any]:
    wait_until(
        lambda: _event_types(_timeline(assistant_client, order_id)) == expected,
        message=f"timeline of order {order_id} never showed {expected}",
    )
    timeline = _timeline(assistant_client, order_id)
    assert timeline is not None
    return timeline


def test_confirmed_order_timeline_shows_its_three_events_in_order(
    order_client: httpx.Client,
    assistant_client: httpx.Client,
    unique_customer_id: str,
    wait_until: Callable[..., None],
) -> None:
    correlation_id = f"e2e-{uuid.uuid4()}"
    order = _create_order(
        order_client, unique_customer_id, _SKU_WITH_STOCK, quantity=2, correlation_id=correlation_id
    )

    timeline = _wait_for_events(
        assistant_client,
        order["id"],
        ["order.created", "stock.reserved", "order.confirmed"],
        wait_until,
    )

    assert timeline["status"] == "confirmed"
    assert timeline["stock_result"] == "reserved"
    assert timeline["rejection_reason"] is None
    assert timeline["customer_id"] == unique_customer_id
    assert timeline["total_amount"] == order["total_amount"]
    assert timeline["items"] == order["lines"]
    # ADR-0012: the id of the POST reaches every event, across three services.
    assert {e["correlation_id"] for e in timeline["events"]} == {correlation_id}


def test_rejected_order_timeline_keeps_the_rejection_reason(
    order_client: httpx.Client,
    assistant_client: httpx.Client,
    unique_customer_id: str,
    wait_until: Callable[..., None],
) -> None:
    # Ask for far more than the seeded stock (SKU-005 = 5 units).
    order = _create_order(
        order_client,
        unique_customer_id,
        _SKU_LOW_STOCK,
        quantity=999,
        correlation_id=f"e2e-{uuid.uuid4()}",
    )

    timeline = _wait_for_events(
        assistant_client,
        order["id"],
        ["order.created", "stock.rejected", "order.rejected"],
        wait_until,
    )

    reason = f"insufficient stock for product {_SKU_LOW_STOCK}"
    assert timeline["status"] == "rejected"
    assert timeline["stock_result"] == "rejected"
    assert timeline["rejection_reason"] == reason
    assert [e.get("reason") for e in timeline["events"]] == [None, reason, reason]


def test_unknown_order_has_no_timeline(assistant_client: httpx.Client) -> None:
    response = assistant_client.get(f"/v1/assistant/orders/{uuid.uuid4()}/timeline")

    assert response.status_code == 404
    assert response.json() == {"message": "order not found"}
