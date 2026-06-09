"""Unit tests for the RejectOrder use case.

All dependencies are faked — no database, no broker.
Mirrors the pattern of test_confirm_order_use_case.py.
"""

import pytest
from shared.contracts.base_event import BaseEvent
from shared.contracts.order_events import OrderRejected

from app.core.exceptions.exceptions import NotFoundError
from app.features.orders.application.contracts.event_publisher import EventPublisher
from app.features.orders.application.contracts.unit_of_work import OrderUnitOfWork
from app.features.orders.application.usecases.reject_order_use_case import (
    RejectOrder,
    RejectOrderParams,
)
from app.features.orders.domain.entities.order import Order, OrderLine, OrderStatus

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# Fakes (same structure as ConfirmOrder tests)
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
        pass


class SpyEventPublisher(EventPublisher):
    def __init__(self) -> None:
        self.calls: list[tuple[BaseEvent, str]] = []

    async def publish(self, event: BaseEvent, routing_key: str) -> None:
        self.calls.append((event, routing_key))


def _params(event_id: str = "evt-1", reason: str = "insufficient stock") -> RejectOrderParams:
    return RejectOrderParams(
        order_id="order-1",
        event_id=event_id,
        correlation_id="order-1",
        reason=reason,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_should_reject_order_and_commit() -> None:
    uow = FakeOrderUnitOfWork(order=_pending_order())
    publisher = SpyEventPublisher()

    result = await RejectOrder(uow, publisher).execute(_params())

    assert result.duplicate is False
    assert uow.saved_order is not None
    assert uow.saved_order.status is OrderStatus.REJECTED
    assert uow.saved_order.rejection_reason == "insufficient stock"
    assert uow.committed is True


async def test_should_publish_order_rejected_with_correct_routing_key() -> None:
    uow = FakeOrderUnitOfWork(order=_pending_order())
    publisher = SpyEventPublisher()

    await RejectOrder(uow, publisher).execute(_params(reason="not enough SKU-A"))

    assert len(publisher.calls) == 1
    event, routing_key = publisher.calls[0]
    assert isinstance(event, OrderRejected)
    assert event.order_id == "order-1"
    assert event.customer_id == "customer-1"
    assert event.reason == "not enough SKU-A"
    assert routing_key == "order.rejected"


async def test_should_record_event_id_in_uow() -> None:
    uow = FakeOrderUnitOfWork(order=_pending_order())

    await RejectOrder(uow, SpyEventPublisher()).execute(_params(event_id="evt-99"))

    assert "evt-99" in uow._seen


async def test_should_return_duplicate_and_not_publish_when_event_already_seen() -> None:
    uow = FakeOrderUnitOfWork(order=_pending_order(), seen_events={"evt-dup"})
    publisher = SpyEventPublisher()

    result = await RejectOrder(uow, publisher).execute(_params(event_id="evt-dup"))

    assert result.duplicate is True
    assert publisher.calls == []
    assert uow.committed is False


async def test_should_raise_when_order_not_found() -> None:
    uow = FakeOrderUnitOfWork(order=None)

    with pytest.raises(NotFoundError):
        await RejectOrder(uow, SpyEventPublisher()).execute(_params())
