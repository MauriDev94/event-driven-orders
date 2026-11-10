from decimal import Decimal
from unittest.mock import Mock

import pytest

from app.core.exceptions.exceptions import NotFoundError
from app.features.orders.application.contracts.order_repository import OrderRepository
from app.features.orders.application.usecases.get_order_use_case import (
    GetOrder,
    GetOrderParams,
)
from app.features.orders.domain.entities.order import Order, OrderLine

pytestmark = pytest.mark.unit


def _params(*, order_id: str, customer_id: str) -> GetOrderParams:
    return GetOrderParams(order_id=order_id, customer_id=customer_id)


def _order(customer_id: str = "customer-1") -> Order:
    return Order(
        id="order-1",
        customer_id=customer_id,
        lines=[OrderLine(product_id="p1", quantity=1, unit_price=Decimal("9.99"))],
    )


def _repository(order: Order | None) -> Mock:
    repository = Mock(spec=OrderRepository)
    repository.get_by_id_for_customer.return_value = order
    return repository


def test_should_return_the_order_the_repository_finds_for_the_customer() -> None:
    repository = _repository(_order("customer-1"))

    order = GetOrder(repository).execute(_params(order_id="order-1", customer_id="customer-1"))

    assert order.id == "order-1"
    repository.get_by_id_for_customer.assert_called_once_with("order-1", "customer-1")


def test_should_raise_not_found_when_the_repository_finds_nothing() -> None:
    use_case = GetOrder(_repository(None))

    with pytest.raises(NotFoundError, match="order not found"):
        use_case.execute(_params(order_id="order-1", customer_id="customer-1"))


def test_should_ask_the_repository_for_the_order_of_that_customer_only() -> None:
    # A foreign order and a missing one both come back as None from a single
    # query, so they raise the same error and cost the same (ADR-0027).
    repository = _repository(None)

    with pytest.raises(NotFoundError):
        GetOrder(repository).execute(_params(order_id="order-1", customer_id="customer-2"))

    repository.get_by_id.assert_not_called()
    repository.get_by_id_for_customer.assert_called_once_with("order-1", "customer-2")


def test_should_not_hand_over_an_order_of_another_customer_if_the_port_returns_one() -> None:
    # Defence in depth: the rule is the use case's, not only the query's.
    use_case = GetOrder(_repository(_order("customer-2")))

    with pytest.raises(NotFoundError, match="order not found"):
        use_case.execute(_params(order_id="order-1", customer_id="customer-1"))
