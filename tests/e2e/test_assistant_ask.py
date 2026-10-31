"""End-to-end tests for assistant-service's ``POST /v1/assistant/ask``.

A rejected order goes through the whole flow (order-service, inventory,
order-service again) and the assistant is asked why. Compose runs the
assistant with ``LLM_PROVIDER=fake`` by default, a model with fixed rules,
so the exact answer is only checked with it; the citations are checked with
any model, because the server builds them from what the tools returned.

The rate limit (5 questions per minute per client IP) also counts questions
asked by hand, so a 429 is waited out once with its Retry-After.

Run with: `make e2e` (Docker required). Not part of CI (ADR-0017).
"""

import time
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest

pytestmark = pytest.mark.e2e

_SKU_LOW_STOCK = "SKU-005"  # seeded with 5 units
_REASON = f"insufficient stock for product {_SKU_LOW_STOCK}"


def _ask(assistant_client: httpx.Client, question: str) -> dict[str, Any]:
    response = assistant_client.post("/v1/assistant/ask", json={"question": question})
    if response.status_code == 429:
        time.sleep(int(response.headers["Retry-After"]) + 1)
        response = assistant_client.post("/v1/assistant/ask", json={"question": question})
    assert response.status_code == 200, response.text
    return response.json()


def _rejected_order(
    order_client: httpx.Client,
    assistant_client: httpx.Client,
    customer_id: str,
    wait_until: Callable[..., None],
) -> tuple[str, list[str]]:
    created = order_client.post(
        "/v1/orders",
        json={
            "customer_id": customer_id,
            "lines": [{"product_id": _SKU_LOW_STOCK, "quantity": 999, "unit_price": "10.00"}],
        },
    )
    assert created.status_code == 201, created.text
    order_id = created.json()["id"]

    def projected() -> bool:
        response = assistant_client.get(f"/v1/assistant/orders/{order_id}/timeline")
        return response.status_code == 200 and response.json()["status"] == "rejected"

    wait_until(projected, message=f"order {order_id} never showed up rejected")
    timeline = assistant_client.get(f"/v1/assistant/orders/{order_id}/timeline").json()
    return order_id, [event["event_id"] for event in timeline["events"]]


def test_assistant_explains_a_rejection_citing_the_order_and_its_events(
    order_client: httpx.Client,
    assistant_client: httpx.Client,
    unique_customer_id: str,
    wait_until: Callable[..., None],
) -> None:
    order_id, event_ids = _rejected_order(
        order_client, assistant_client, unique_customer_id, wait_until
    )

    body = _ask(assistant_client, f"¿Por qué se rechazó el pedido {order_id}?")

    assert body["outcome"] == "answered"
    assert {"order_id": order_id, "event_ids": event_ids} in body["citations"]
    assert {"name": "get_order_timeline", "args": {"order_id": order_id}} in body["tool_calls"]
    if body["model"] == "fake":
        assert body["answer"] == f"El pedido {order_id} está rechazado (motivo: {_REASON})."


def test_assistant_says_it_has_no_data_for_an_unknown_order(
    assistant_client: httpx.Client,
) -> None:
    body = _ask(assistant_client, f"¿Qué pasó con el pedido {uuid.uuid4()}?")

    assert body["outcome"] == "no_data"
    assert body["citations"] == []
