"""End-to-end tests for the full order flow.

Exercise the REAL stack (RabbitMQ + 2x Postgres + Mailpit + the 3 services),
started with `make up`. A single POST to order-service propagates through
inventory-service and notification-service via RabbitMQ; the outcome is
observed only through public boundaries — order-service's HTTP API and
Mailpit's HTTP API — never by reaching into another service's database.

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


def _emails_for(mailpit_client: httpx.Client, recipient: str) -> list[dict[str, Any]]:
    response = mailpit_client.get("/api/v1/search", params={"query": f"to:{recipient}"})
    response.raise_for_status()
    messages: list[dict[str, Any]] = response.json()["messages"]
    # Mailpit's search matches substrings (x-<recipient> too): keep exact matches.
    return [m for m in messages if any(to["Address"] == recipient for to in m["To"])]


def _subject(message: dict[str, Any]) -> str:
    return str(message["Subject"])


def _body(mailpit_client: httpx.Client, message: dict[str, Any]) -> str:
    # The search result only carries a snippet; the full text is per message.
    response = mailpit_client.get(f"/api/v1/message/{message['ID']}")
    response.raise_for_status()
    return str(response.json()["Text"])


def test_happy_path_order_is_confirmed_and_confirmation_email_is_sent(
    order_client: httpx.Client,
    mailpit_client: httpx.Client,
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
        lambda: any(order_id in _subject(m) for m in _emails_for(mailpit_client, recipient)),
        message=f"no confirmation email received for {recipient}",
    )

    emails = _emails_for(mailpit_client, recipient)
    confirmation = next(m for m in emails if order_id in _subject(m))
    assert "confirmed" in _subject(confirmation)


def test_rejection_path_order_is_rejected_and_rejection_email_is_sent(
    order_client: httpx.Client,
    mailpit_client: httpx.Client,
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
        lambda: any(order_id in _subject(m) for m in _emails_for(mailpit_client, recipient)),
        message=f"no rejection email received for {recipient}",
    )

    emails = _emails_for(mailpit_client, recipient)
    rejection = next(m for m in emails if order_id in _subject(m))
    assert "rejected" in _subject(rejection)
    assert _SKU_LOW_STOCK in _body(mailpit_client, rejection)
