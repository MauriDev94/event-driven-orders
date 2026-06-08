from decimal import Decimal

import pytest

from app.core.exceptions.exceptions import NotFoundError
from app.features.orders.application.contracts.order_repository import OrderRepository
from app.features.orders.application.usecases.get_order_use_case import GetOrder
from app.features.orders.domain.entities.order import Order, OrderLine

pytestmark = pytest.mark.unit


class FakeOrderRepository(OrderRepository):
    def __init__(self, order: Order | None = None) -> None:
        self._order = order

    def add(self, order: Order) -> Order:
        return order

    def get_by_id(self, order_id: str) -> Order | None:
        if self._order is not None and self._order.id == order_id:
            return self._order
        return None

    def update(self, order: Order) -> Order:
        return order


def _order() -> Order:
    return Order(
        id="order-1",
        customer_id="customer-1",
        lines=[OrderLine(product_id="p1", quantity=1, unit_price=Decimal("9.99"))],
    )


def test_should_return_the_order_when_it_exists() -> None:
    use_case = GetOrder(FakeOrderRepository(_order()))

    order = use_case.execute("order-1")

    assert order.id == "order-1"


def test_should_raise_not_found_when_the_order_is_missing() -> None:
    use_case = GetOrder(FakeOrderRepository(None))

    with pytest.raises(NotFoundError):
        use_case.execute("missing")
