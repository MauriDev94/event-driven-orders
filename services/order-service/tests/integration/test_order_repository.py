from uuid import uuid4

import pytest

from app.features.orders.infrastructure.repositories.order_repository import (
    SqlAlchemyOrderRepository,
)

pytestmark = pytest.mark.integration


def test_should_find_the_order_of_the_customer(session_factory, seed_order) -> None:
    order_id = str(uuid4())
    seed_order(order_id=order_id, customer_id="customer-1")
    session = session_factory()
    try:
        found = SqlAlchemyOrderRepository(session).get_by_id_for_customer(order_id, "customer-1")
    finally:
        session.close()

    assert found is not None
    assert found.id == order_id
    assert found.customer_id == "customer-1"
    assert len(found.lines) == 1


def test_should_return_none_for_an_order_of_another_customer(session_factory, seed_order) -> None:
    order_id = str(uuid4())
    seed_order(order_id=order_id, customer_id="customer-2")
    session = session_factory()
    try:
        found = SqlAlchemyOrderRepository(session).get_by_id_for_customer(order_id, "customer-1")
    finally:
        session.close()

    assert found is None


def test_should_return_none_for_a_missing_order(session_factory, seed_order) -> None:
    seed_order(customer_id="customer-1")
    session = session_factory()
    try:
        found = SqlAlchemyOrderRepository(session).get_by_id_for_customer(
            str(uuid4()), "customer-1"
        )
    finally:
        session.close()

    assert found is None


def test_should_filter_by_customer_inside_the_query(session_factory, seed_order) -> None:
    # One statement, with the customer in its WHERE clause: a foreign order
    # costs the same as a missing one.
    from sqlalchemy import event

    order_id = str(uuid4())
    seed_order(order_id=order_id, customer_id="customer-2")
    session = session_factory()
    statements: list[str] = []
    engine = session.get_bind()

    def capture(conn, cursor, statement, parameters, context, executemany) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        SqlAlchemyOrderRepository(session).get_by_id_for_customer(order_id, "customer-1")
    finally:
        event.remove(engine, "before_cursor_execute", capture)
        session.close()

    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    assert len(selects) == 1
    assert "customer_id" in selects[0].split("WHERE", 1)[1]
