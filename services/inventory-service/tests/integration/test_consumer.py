"""Integration tests for the OrderCreated consumer handler.

These tests invoke ``handle_order_created`` directly with a fake aio_pika
message — no RabbitMQ needed.  The UnitOfWork runs against a real Postgres
(testcontainers locally, service container in CI) so the full path is
exercised: deserialize → use case → atomic DB write → publish (spy).
"""

from unittest.mock import AsyncMock

import pytest
from shared.contracts.inventory_events import StockRejected, StockReserved
from shared.contracts.order_events import OrderCreated, OrderItem

from app.features.inventory.application.usecases.reserve_stock_use_case import ReserveStock
from app.features.inventory.infrastructure.persistence.sqlalchemy_unit_of_work import (
    SqlAlchemyUnitOfWork,
)
from app.features.inventory.presentation.consumers.order_created_consumer import (
    build_order_created_handler,
)

pytestmark = pytest.mark.integration


def _fake_message(event: OrderCreated) -> AsyncMock:
    """Build a fake aio_pika AbstractIncomingMessage from an OrderCreated event."""
    msg = AsyncMock()
    msg.body = event.model_dump_json().encode()
    msg.message_id = event.event_id
    msg.message_id = event.event_id
    return msg


def _event(order_id: str = "order-1", items: list[tuple[str, int]] | None = None) -> OrderCreated:
    if items is None:
        items = [("SKU-A", 2)]
    return OrderCreated(
        correlation_id=order_id,
        order_id=order_id,
        customer_id="customer-1",
        items=[OrderItem(product_id=sku, quantity=qty, unit_price="10.00") for sku, qty in items],
        total_amount="20.00",
    )


async def test_should_reserve_stock_and_publish_reserved_when_stock_available(
    session_factory, seed_products, spy_publisher
) -> None:
    seed_products({"SKU-A": 5})
    uow = SqlAlchemyUnitOfWork(session_factory)
    use_case = ReserveStock(uow, spy_publisher)
    handler = build_order_created_handler(use_case)

    msg = _fake_message(_event())
    await handler(msg)

    assert len(spy_publisher.calls) == 1
    event, routing_key = spy_publisher.calls[0]
    assert isinstance(event, StockReserved)
    assert routing_key == "stock.reserved"
    assert event.order_id == "order-1"
    msg.ack.assert_awaited_once()


async def test_should_publish_rejected_when_stock_insufficient(
    session_factory, seed_products, spy_publisher
) -> None:
    seed_products({"SKU-A": 1})
    uow = SqlAlchemyUnitOfWork(session_factory)
    use_case = ReserveStock(uow, spy_publisher)
    handler = build_order_created_handler(use_case)

    msg = _fake_message(_event(items=[("SKU-A", 5)]))
    await handler(msg)

    assert len(spy_publisher.calls) == 1
    event, _ = spy_publisher.calls[0]
    assert isinstance(event, StockRejected)
    assert "SKU-A" in event.reason
    msg.ack.assert_awaited_once()


async def test_should_ack_without_republishing_on_duplicate_event(
    session_factory, seed_products, spy_publisher
) -> None:
    """Second delivery of the same event must ACK but NOT re-reserve or re-publish."""
    seed_products({"SKU-A": 5})
    uow_1 = SqlAlchemyUnitOfWork(session_factory)
    use_case_1 = ReserveStock(uow_1, spy_publisher)
    handler = build_order_created_handler(use_case_1)

    event = _event()
    await handler(_fake_message(event))
    assert len(spy_publisher.calls) == 1

    # Second delivery — same event_id.
    uow_2 = SqlAlchemyUnitOfWork(session_factory)
    use_case_2 = ReserveStock(uow_2, spy_publisher)
    handler2 = build_order_created_handler(use_case_2)
    dup_msg = _fake_message(event)
    await handler2(dup_msg)

    # No additional event published.
    assert len(spy_publisher.calls) == 1
    dup_msg.ack.assert_awaited_once()
