from decimal import Decimal

import pytest
from shared.contracts.order_events import OrderCreated

from app.features.orders.application.mappers.order_event_mapper import (
    map_order_to_order_created,
)
from app.features.orders.domain.entities.order import Order, OrderLine

pytestmark = pytest.mark.unit


def _order() -> Order:
    return Order(
        id="order-1",
        customer_id="customer-1",
        lines=[
            OrderLine(product_id="p1", quantity=2, unit_price=Decimal("10.00")),
            OrderLine(product_id="p2", quantity=1, unit_price=Decimal("5.50")),
        ],
    )


def test_should_map_order_identity_when_building_event() -> None:
    event = map_order_to_order_created(_order())

    assert isinstance(event, OrderCreated)
    assert event.order_id == "order-1"
    assert event.customer_id == "customer-1"


def test_should_pin_event_type_to_order_created() -> None:
    assert map_order_to_order_created(_order()).event_type == "order.created"


def test_should_map_every_line_into_an_item() -> None:
    event = map_order_to_order_created(_order())

    assert [(i.product_id, i.quantity, i.unit_price) for i in event.items] == [
        ("p1", 2, Decimal("10.00")),
        ("p2", 1, Decimal("5.50")),
    ]


def test_should_carry_the_total_amount() -> None:
    assert map_order_to_order_created(_order()).total_amount == Decimal("25.50")


def test_should_use_order_id_as_correlation_id_for_tracing() -> None:
    # correlation_id ties together every event of this order's lifecycle.
    assert map_order_to_order_created(_order()).correlation_id == "order-1"
