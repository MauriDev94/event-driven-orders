"""End-to-end tests for the full order flow.

Exercise the REAL stack (RabbitMQ + 2x Postgres + Mailhog + the 3 services),
started with `make up`. A single POST to order-service propagates through
inventory-service and notification-service via RabbitMQ; the outcome is
observed only through public boundaries — order-service's HTTP API and
Mailhog's HTTP API — never by reaching into another service's database.

Run with: `make e2e` (Docker required). Not part of CI — see README
"Testing" for why and for the idempotency-coverage decision.
"""

from collections.abc import Callable
from typing import Any

import httpx
import pytest

pytestmark = pytest.mark.e2e

# Seeded by the inventory-service migration (SKU-001=100 .. SKU-005=5).
_SKU_WITH_STOCK = "SKU-001"
_SKU_LOW_STOCK = "SKU-005"


def _create_order(
    order_client: httpx.Client, customer_id: str, product_id: str, quantity: int
) -> dict[str, Any]:
    response = order_client.post(
        "/v1/orders",
        json={
            "customer_id": customer_id,
            "lines": [{"product_id": product_id, "quantity": quantity, "unit_price": "10.00"}],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _order_status(order_client: httpx.Client, order_id: str) -> str:
    response = order_client.get(f"/v1/orders/{order_id}")
    response.raise_for_status()
    return str(response.json()["status"])


def _emails_for(mailhog_client: httpx.Client, recipient: str) -> list[dict[str, Any]]:
    response = mailhog_client.get("/api/v2/messages", params={"limit": 50})
    response.raise_for_status()
    items: list[dict[str, Any]] = response.json()["items"]
    return [
        item
        for item in items
        if any(f"{to['Mailbox']}@{to['Domain']}" == recipient for to in item["To"])
    ]


def _subject(message: dict[str, Any]) -> str:
    return str(message["Content"]["Headers"].get("Subject", [""])[0])


def _body(message: dict[str, Any]) -> str:
    return str(message["Content"]["Body"])


def test_happy_path_order_is_confirmed_and_confirmation_email_is_sent(
    order_client: httpx.Client,
    mailhog_client: httpx.Client,
    unique_customer_id: str,
    wait_until: Callable[..., None],
) -> None:
    order = _create_order(order_client, unique_customer_id, _SKU_WITH_STOCK, quantity=1)
    order_id = order["id"]
    recipient = f"{unique_customer_id}@example.com"

    wait_until(
        lambda: _order_status(order_client, order_id) == "confirmed",
        message=f"order {order_id} never reached status 'confirmed'",
    )

    wait_until(
        lambda: any(order_id in _subject(m) for m in _emails_for(mailhog_client, recipient)),
        message=f"no confirmation email received for {recipient}",
    )

    emails = _emails_for(mailhog_client, recipient)
    confirmation = next(m for m in emails if order_id in _subject(m))
    assert "confirmed" in _subject(confirmation)


def test_rejection_path_order_is_rejected_and_rejection_email_is_sent(
    order_client: httpx.Client,
    mailhog_client: httpx.Client,
    unique_customer_id: str,
    wait_until: Callable[..., None],
) -> None:
    # Ask for far more than the seeded stock (SKU-005 = 5 units).
    order = _create_order(order_client, unique_customer_id, _SKU_LOW_STOCK, quantity=999)
    order_id = order["id"]
    recipient = f"{unique_customer_id}@example.com"

    wait_until(
        lambda: _order_status(order_client, order_id) == "rejected",
        message=f"order {order_id} never reached status 'rejected'",
    )

    wait_until(
        lambda: any(order_id in _subject(m) for m in _emails_for(mailhog_client, recipient)),
        message=f"no rejection email received for {recipient}",
    )

    emails = _emails_for(mailhog_client, recipient)
    rejection = next(m for m in emails if order_id in _subject(m))
    assert "rejected" in _subject(rejection)
    assert _SKU_LOW_STOCK in _body(rejection)
