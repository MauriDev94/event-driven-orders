"""Unit tests for the ConfirmOrder use case.

All dependencies are faked — no database, no broker.
Pattern mirrors test_reserve_stock_use_case.py from inventory-service.
"""

import pytest
from shared.contracts.base_event import BaseEvent
from shared.contracts.order_events import OrderConfirmed

from app.core.exceptions.exceptions import NotFoundError
from app.features.orders.application.contracts.event_publisher import EventPublisher
from app.features.orders.application.contracts.unit_of_work import OrderUnitOfWork
from app.features.orders.application.usecases.confirm_order_use_case import (
    ConfirmOrder,
    ConfirmOrderParams,
)
from app.features.orders.domain.entities.order import Order, OrderLine, OrderStatus

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


def _pending_order() -> Order:
    from decimal import Decimal

    return Order(
        id="order-1",
        customer_id="customer-1",
        lines=[OrderLine(product_id="p1", quantity=1, unit_price=Decimal("10.00"))],
        status=OrderStatus.PENDING,
    )


class FakeOrderUnitOfWork(OrderUnitOfWork):
    def __init__(self, order: Order | None = None, *, seen_events: set[str] | None = None) -> None:
        self._order = order
        self._seen: set[str] = seen_events or set()
        self.committed = False
        self.rolled_back = False
        self.saved_order: Order | None = None

    def register_event(self, event_id: str) -> bool:
        if event_id in self._seen:
            return False
        self._seen.add(event_id)
        return True

    def get_order(self, order_id: str) -> Order | None:
        return self._order if (self._order and self._order.id == order_id) else None

    def save_order(self, order: Order) -> None:
        self.saved_order = order

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True


class SpyEventPublisher(EventPublisher):
    def __init__(self) -> None:
        self.calls: list[tuple[BaseEvent, str]] = []

    async def publish(self, event: BaseEvent, routing_key: str) -> None:
        self.calls.append((event, routing_key))


def _params(event_id: str = "evt-1") -> ConfirmOrderParams:
    return ConfirmOrderParams(order_id="order-1", event_id=event_id, correlation_id="order-1")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_should_confirm_order_and_commit() -> None:
    uow = FakeOrderUnitOfWork(order=_pending_order())
    publisher = SpyEventPublisher()

    result = await ConfirmOrder(uow, publisher).execute(_params())

    assert result.duplicate is False
    assert uow.saved_order is not None
    assert uow.saved_order.status is OrderStatus.CONFIRMED
    assert uow.committed is True


async def test_should_publish_order_confirmed_with_correct_routing_key() -> None:
    uow = FakeOrderUnitOfWork(order=_pending_order())
    publisher = SpyEventPublisher()

    await ConfirmOrder(uow, publisher).execute(_params())

    assert len(publisher.calls) == 1
    event, routing_key = publisher.calls[0]
    assert isinstance(event, OrderConfirmed)
    assert event.order_id == "order-1"
    assert event.customer_id == "customer-1"
    assert event.correlation_id == "order-1"
    assert routing_key == "order.confirmed"


async def test_should_record_event_id_in_uow() -> None:
    uow = FakeOrderUnitOfWork(order=_pending_order())

    await ConfirmOrder(uow, SpyEventPublisher()).execute(_params(event_id="evt-42"))

    assert "evt-42" in uow._seen


async def test_should_return_duplicate_and_not_publish_when_event_already_seen() -> None:
    uow = FakeOrderUnitOfWork(order=_pending_order(), seen_events={"evt-dup"})
    publisher = SpyEventPublisher()

    result = await ConfirmOrder(uow, publisher).execute(_params(event_id="evt-dup"))

    assert result.duplicate is True
    assert publisher.calls == []
    assert uow.committed is False


async def test_should_raise_when_order_not_found() -> None:
    uow = FakeOrderUnitOfWork(order=None)

    with pytest.raises(NotFoundError):
        await ConfirmOrder(uow, SpyEventPublisher()).execute(_params())
