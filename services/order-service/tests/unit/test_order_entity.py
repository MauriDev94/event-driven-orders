from decimal import Decimal

import pytest

from app.features.orders.domain.entities.order import Order, OrderLine, OrderStatus

pytestmark = pytest.mark.unit


def _order() -> Order:
    return Order(
        id="order-1",
        customer_id="customer-1",
        lines=[OrderLine(product_id="p1", quantity=2, unit_price=Decimal("10.00"))],
    )


def test_should_start_as_pending_when_created() -> None:
    assert _order().status is OrderStatus.PENDING


def test_should_compute_total_from_lines() -> None:
    order = Order(
        id="order-1",
        customer_id="customer-1",
        lines=[
            OrderLine(product_id="p1", quantity=2, unit_price=Decimal("10.00")),
            OrderLine(product_id="p2", quantity=1, unit_price=Decimal("5.50")),
        ],
    )

    assert order.total_amount == Decimal("25.50")


def test_should_confirm_when_pending() -> None:
    order = _order()

    order.confirm()

    assert order.status is OrderStatus.CONFIRMED


def test_should_reject_with_reason_when_pending() -> None:
    order = _order()

    order.reject("out of stock")

    assert order.status is OrderStatus.REJECTED
    assert order.rejection_reason == "out of stock"


def test_should_raise_when_confirming_a_rejected_order() -> None:
    order = _order()
    order.reject("out of stock")

    with pytest.raises(ValueError):
        order.confirm()


def test_should_raise_when_order_has_no_lines() -> None:
    with pytest.raises(ValueError):
        Order(id="order-1", customer_id="customer-1", lines=[])
