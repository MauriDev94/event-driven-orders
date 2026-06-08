from decimal import Decimal

import pytest
from shared.contracts.base_event import BaseEvent
from shared.contracts.order_events import OrderCreated

from app.features.orders.application.contracts.event_publisher import EventPublisher
from app.features.orders.application.contracts.order_repository import OrderRepository
from app.features.orders.application.usecases.create_order_use_case import (
    CreateOrder,
    CreateOrderLineParams,
    CreateOrderParams,
)
from app.features.orders.domain.entities.order import Order, OrderStatus

pytestmark = pytest.mark.unit


class FakeOrderRepository(OrderRepository):
    """In-memory repo that assigns a deterministic id on add."""

    def __init__(self) -> None:
        self.saved: list[Order] = []

    def add(self, order: Order) -> Order:
        order.id = "generated-id"
        self.saved.append(order)
        return order

    def get_by_id(self, order_id: str) -> Order | None:
        return next((o for o in self.saved if o.id == order_id), None)

    def update(self, order: Order) -> Order:
        return order


class SpyEventPublisher(EventPublisher):
    """Records every publish call instead of touching a broker."""

    def __init__(self) -> None:
        self.calls: list[tuple[BaseEvent, str]] = []

    async def publish(self, event: BaseEvent, routing_key: str) -> None:
        self.calls.append((event, routing_key))


def _params() -> CreateOrderParams:
    return CreateOrderParams(
        customer_id="customer-1",
        lines=[CreateOrderLineParams(product_id="p1", quantity=2, unit_price=Decimal("10.00"))],
    )


async def test_should_persist_a_pending_order_when_creating() -> None:
    repo, publisher = FakeOrderRepository(), SpyEventPublisher()

    await CreateOrder(repo, publisher).execute(_params())

    assert len(repo.saved) == 1
    assert repo.saved[0].status is OrderStatus.PENDING


async def test_should_return_the_persisted_order_with_its_id() -> None:
    repo, publisher = FakeOrderRepository(), SpyEventPublisher()

    order = await CreateOrder(repo, publisher).execute(_params())

    assert order.id == "generated-id"
    assert order.customer_id == "customer-1"


async def test_should_publish_order_created_once_under_order_created_routing_key() -> None:
    repo, publisher = FakeOrderRepository(), SpyEventPublisher()

    await CreateOrder(repo, publisher).execute(_params())

    assert len(publisher.calls) == 1
    event, routing_key = publisher.calls[0]
    assert isinstance(event, OrderCreated)
    assert routing_key == "order.created"


async def test_should_publish_event_carrying_the_persisted_id() -> None:
    # Proves publish happens AFTER persist: the event has the repo-assigned id.
    repo, publisher = FakeOrderRepository(), SpyEventPublisher()

    await CreateOrder(repo, publisher).execute(_params())

    event, _ = publisher.calls[0]
    assert event.order_id == "generated-id"
    assert event.total_amount == Decimal("20.00")
