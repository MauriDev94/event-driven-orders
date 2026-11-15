"""End-to-end isolation between two anonymous visitors (ADR-0027).

Visitor A places an order. Visitor B, with a session of their own, can't read
it from order-service or from assistant-service's timeline, and the assistant
doesn't show it to them. A foreign order answers exactly like a missing one,
so B can't even learn that it exists.

Run with: `make e2e` (Docker required). Not part of CI (ADR-0017).
"""

import uuid
from collections.abc import Callable

import pytest
from conftest import CustomerSession, ask_assistant

pytestmark = pytest.mark.e2e


def test_a_visitor_never_sees_the_order_of_another(
    customer_session: CustomerSession,
    other_customer_session: CustomerSession,
    wait_until: Callable[..., None],
) -> None:
    owner, visitor = customer_session, other_customer_session
    created = owner.client.post(
        "/v1/orders",
        json={"lines": [{"product_id": "SKU-001", "quantity": 1, "unit_price": "10.00"}]},
    )
    assert created.status_code == 201, created.text
    order_id = created.json()["id"]
    wait_until(
        lambda: owner.assistant.get(f"/v1/assistant/orders/{order_id}/timeline").status_code == 200,
        message=f"order {order_id} never reached the assistant's read model",
    )
    missing_id = str(uuid.uuid4())

    assert owner.client.get(f"/v1/orders/{order_id}").status_code == 200

    foreign = visitor.client.get(f"/v1/orders/{order_id}")
    missing = visitor.client.get(f"/v1/orders/{missing_id}")
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()

    foreign = visitor.assistant.get(f"/v1/assistant/orders/{order_id}/timeline")
    missing = visitor.assistant.get(f"/v1/assistant/orders/{missing_id}/timeline")
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()

    by_id = ask_assistant(visitor.assistant, f"¿Qué pasó con el pedido {order_id}?")
    assert by_id["outcome"] == "no_data"
    assert by_id["citations"] == []

    mine = ask_assistant(visitor.assistant, "¿Cuáles son mis pedidos?")
    assert order_id not in [citation["order_id"] for citation in mine["citations"]]
    assert order_id not in mine["answer"]
