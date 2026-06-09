"""Integration tests for the inventory-results consumer handler.

Invokes ``build_inventory_result_handler`` directly with fake aio_pika
messages — no RabbitMQ needed. The UnitOfWork runs against a real Postgres
(testcontainers locally, service container in CI) so the full path is
exercised: deserialize → use case → atomic DB write → publish (spy).

Pattern mirrors test_consumer.py from inventory-service (Fase 2).
"""

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from shared.contracts.inventory_events import StockRejected, StockReserved
from shared.contracts.order_events import OrderConfirmed, OrderRejected

from app.features.orders.application.usecases.confirm_order_use_case import ConfirmOrder
from app.features.orders.application.usecases.reject_order_use_case import RejectOrder
from app.features.orders.domain.entities.order import OrderStatus
from app.features.orders.infrastructure.persistence.sqlalchemy_order_unit_of_work import (
    SqlAlchemyOrderUnitOfWork,
)
from app.features.orders.presentation.consumers.inventory_results_consumer import (
    build_inventory_result_handler,
)

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_message(event) -> AsyncMock:
    msg = AsyncMock()
    msg.body = event.model_dump_json().encode()
    return msg


def _stock_reserved(order_id: str, event_id: str | None = None) -> StockReserved:
    return StockReserved(
        order_id=order_id,
        event_id=event_id or str(uuid4()),
        correlation_id=order_id,
    )


def _stock_rejected(
    order_id: str, event_id: str | None = None, reason: str = "no stock"
) -> StockRejected:
    return StockRejected(
        order_id=order_id,
        event_id=event_id or str(uuid4()),
        correlation_id=order_id,
        reason=reason,
    )


# ---------------------------------------------------------------------------
# StockReserved → ConfirmOrder
# ---------------------------------------------------------------------------


async def test_should_confirm_order_and_publish_order_confirmed(
    session_factory, seed_order, spy_publisher
) -> None:
    seeded = seed_order()
    order_id = seeded.id

    uow = SqlAlchemyOrderUnitOfWork(session_factory)
    confirm_uc = ConfirmOrder(uow, spy_publisher)
    reject_uc = RejectOrder(SqlAlchemyOrderUnitOfWork(session_factory), spy_publisher)
    handler = build_inventory_result_handler(confirm_uc, reject_uc)

    await handler(_fake_message(_stock_reserved(order_id)))

    # DB: order must be confirmed
    with SqlAlchemyOrderUnitOfWork(session_factory) as check_uow:
        order = check_uow.get_order(order_id)
    assert order is not None
    assert order.status is OrderStatus.CONFIRMED

    # Broker: OrderConfirmed published with correct routing key
    assert len(spy_publisher.calls) == 1
    event, routing_key = spy_publisher.calls[0]
    assert isinstance(event, OrderConfirmed)
    assert event.order_id == order_id
    assert routing_key == "order.confirmed"


# ---------------------------------------------------------------------------
# StockRejected → RejectOrder
# ---------------------------------------------------------------------------


async def test_should_reject_order_and_publish_order_rejected(
    session_factory, seed_order, spy_publisher
) -> None:
    seeded = seed_order()
    order_id = seeded.id

    uow = SqlAlchemyOrderUnitOfWork(session_factory)
    confirm_uc = ConfirmOrder(SqlAlchemyOrderUnitOfWork(session_factory), spy_publisher)
    reject_uc = RejectOrder(uow, spy_publisher)
    handler = build_inventory_result_handler(confirm_uc, reject_uc)

    await handler(_fake_message(_stock_rejected(order_id, reason="insufficient stock for p1")))

    with SqlAlchemyOrderUnitOfWork(session_factory) as check_uow:
        order = check_uow.get_order(order_id)
    assert order is not None
    assert order.status is OrderStatus.REJECTED
    assert order.rejection_reason == "insufficient stock for p1"

    assert len(spy_publisher.calls) == 1
    event, routing_key = spy_publisher.calls[0]
    assert isinstance(event, OrderRejected)
    assert event.order_id == order_id
    assert event.reason == "insufficient stock for p1"
    assert routing_key == "order.rejected"


# ---------------------------------------------------------------------------
# Idempotency: same StockReserved delivered twice
# ---------------------------------------------------------------------------


async def test_should_not_double_confirm_on_duplicate_stock_reserved(
    session_factory, seed_order, spy_publisher
) -> None:
    seeded = seed_order()
    order_id = seeded.id
    event_id = str(uuid4())

    event = _stock_reserved(order_id, event_id=event_id)

    uow_1 = SqlAlchemyOrderUnitOfWork(session_factory)
    confirm_uc_1 = ConfirmOrder(uow_1, spy_publisher)
    handler_1 = build_inventory_result_handler(
        confirm_uc_1, RejectOrder(SqlAlchemyOrderUnitOfWork(session_factory), spy_publisher)
    )
    await handler_1(_fake_message(event))
    assert len(spy_publisher.calls) == 1

    # Second delivery — same event_id.
    uow_2 = SqlAlchemyOrderUnitOfWork(session_factory)
    confirm_uc_2 = ConfirmOrder(uow_2, spy_publisher)
    handler_2 = build_inventory_result_handler(
        confirm_uc_2, RejectOrder(SqlAlchemyOrderUnitOfWork(session_factory), spy_publisher)
    )
    dup_msg = _fake_message(event)
    await handler_2(dup_msg)

    # No additional event published (still 1 total).
    assert len(spy_publisher.calls) == 1
    dup_msg.ack.assert_awaited_once()

    with SqlAlchemyOrderUnitOfWork(session_factory) as check_uow:
        order = check_uow.get_order(order_id)
    assert order.status is OrderStatus.CONFIRMED


# ---------------------------------------------------------------------------
# Idempotency: same StockRejected delivered twice
# ---------------------------------------------------------------------------


async def test_should_not_double_reject_on_duplicate_stock_rejected(
    session_factory, seed_order, spy_publisher
) -> None:
    seeded = seed_order()
    order_id = seeded.id
    event_id = str(uuid4())

    event = _stock_rejected(order_id, event_id=event_id)

    uow_1 = SqlAlchemyOrderUnitOfWork(session_factory)
    reject_uc_1 = RejectOrder(uow_1, spy_publisher)
    handler_1 = build_inventory_result_handler(
        ConfirmOrder(SqlAlchemyOrderUnitOfWork(session_factory), spy_publisher), reject_uc_1
    )
    await handler_1(_fake_message(event))
    assert len(spy_publisher.calls) == 1

    uow_2 = SqlAlchemyOrderUnitOfWork(session_factory)
    reject_uc_2 = RejectOrder(uow_2, spy_publisher)
    handler_2 = build_inventory_result_handler(
        ConfirmOrder(SqlAlchemyOrderUnitOfWork(session_factory), spy_publisher), reject_uc_2
    )
    dup_msg = _fake_message(event)
    await handler_2(dup_msg)

    assert len(spy_publisher.calls) == 1
    dup_msg.ack.assert_awaited_once()
