import pytest

from app.features.inventory.domain.entities.product import Product

pytestmark = pytest.mark.unit


def test_should_reserve_when_enough_stock() -> None:
    product = Product(id="p1", sku="SKU-1", available_quantity=10)

    product.reserve(3)

    assert product.available_quantity == 7


def test_should_report_can_reserve_correctly() -> None:
    product = Product(id="p1", sku="SKU-1", available_quantity=5)

    assert product.can_reserve(5) is True
    assert product.can_reserve(6) is False


def test_should_raise_when_reserving_more_than_available() -> None:
    product = Product(id="p1", sku="SKU-1", available_quantity=2)

    with pytest.raises(ValueError):
        product.reserve(3)


def test_should_raise_when_quantity_is_negative_on_creation() -> None:
    with pytest.raises(ValueError):
        Product(id="p1", sku="SKU-1", available_quantity=-1)
