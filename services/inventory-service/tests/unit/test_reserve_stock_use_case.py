import pytest
from shared.contracts.base_event import BaseEvent
from shared.contracts.inventory_events import StockRejected, StockReserved

from app.features.inventory.application.contracts.event_publisher import EventPublisher
from app.features.inventory.application.contracts.inventory_repository import (
    InventoryRepository,
    ReservationItem,
)
from app.features.inventory.application.contracts.unit_of_work import UnitOfWork
from app.features.inventory.application.usecases.reserve_stock_use_case import (
    ReserveStock,
    ReserveStockItem,
    ReserveStockParams,
)

pytestmark = pytest.mark.unit


class FakeInventoryRepository(InventoryRepository):
    """In-memory stand-in that simulates the atomic primitives.

    ``stock`` holds sku -> available units; ``processed`` is the set of already
    seen event ids. ``reserve_all`` is all-or-nothing, mirroring the savepoint
    behaviour of the real SQLAlchemy repository.
    """

    def __init__(self, stock: dict[str, int], processed: set[str] | None = None) -> None:
        self.stock = stock
        self.processed = processed if processed is not None else set()
        self.reserve_calls = 0

    def register_event(self, event_id: str) -> bool:
        if event_id in self.processed:
            return False
        self.processed.add(event_id)
        return True

    def reserve_all(self, items: list[ReservationItem]) -> str | None:
        self.reserve_calls += 1
        for item in items:
            if self.stock.get(item.sku, 0) < item.quantity:
                return item.sku  # insufficient -> nothing is decremented
        for item in items:
            self.stock[item.sku] -= item.quantity
        return None


class FakeUnitOfWork(UnitOfWork):
    def __init__(self, inventory: FakeInventoryRepository) -> None:
        self.inventory = inventory
        self.committed = False
        self.rolled_back = False

    def __enter__(self) -> "FakeUnitOfWork":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        if not self.committed:
            self.rolled_back = True

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True


class SpyEventPublisher(EventPublisher):
    def __init__(self) -> None:
        self.calls: list[tuple[BaseEvent, str]] = []

    async def publish(self, event: BaseEvent, routing_key: str) -> None:
        self.calls.append((event, routing_key))


def _params(event_id: str = "evt-1") -> ReserveStockParams:
    return ReserveStockParams(
        order_id="order-1",
        event_id=event_id,
        correlation_id="order-1",
        items=[
            ReserveStockItem(product_id="SKU-A", quantity=2),
            ReserveStockItem(product_id="SKU-B", quantity=1),
        ],
    )


async def test_should_reserve_and_publish_stock_reserved_when_enough_stock() -> None:
    repo = FakeInventoryRepository(stock={"SKU-A": 5, "SKU-B": 3})
    uow, publisher = FakeUnitOfWork(repo), SpyEventPublisher()

    result = await ReserveStock(uow, publisher).execute(_params())

    assert result.reserved is True
    assert repo.stock == {"SKU-A": 3, "SKU-B": 2}
    assert uow.committed is True
    assert len(publisher.calls) == 1
    event, routing_key = publisher.calls[0]
    assert isinstance(event, StockReserved)
    assert routing_key == "stock.reserved"
    assert event.order_id == "order-1"
    assert event.correlation_id == "order-1"


async def test_should_reject_and_not_decrement_when_stock_insufficient() -> None:
    repo = FakeInventoryRepository(stock={"SKU-A": 1, "SKU-B": 3})
    uow, publisher = FakeUnitOfWork(repo), SpyEventPublisher()

    result = await ReserveStock(uow, publisher).execute(_params())

    assert result.reserved is False
    assert repo.stock == {"SKU-A": 1, "SKU-B": 3}  # nothing decremented
    assert len(publisher.calls) == 1
    event, routing_key = publisher.calls[0]
    assert isinstance(event, StockRejected)
    assert routing_key == "stock.rejected"
    assert "SKU-A" in event.reason


async def test_should_record_event_even_when_rejected_so_redelivery_is_idempotent() -> None:
    repo = FakeInventoryRepository(stock={"SKU-A": 0, "SKU-B": 0})
    uow, publisher = FakeUnitOfWork(repo), SpyEventPublisher()

    await ReserveStock(uow, publisher).execute(_params(event_id="evt-9"))

    assert "evt-9" in repo.processed
    assert uow.committed is True


async def test_should_skip_and_not_publish_when_event_already_processed() -> None:
    repo = FakeInventoryRepository(stock={"SKU-A": 5, "SKU-B": 3}, processed={"evt-dup"})
    uow, publisher = FakeUnitOfWork(repo), SpyEventPublisher()

    result = await ReserveStock(uow, publisher).execute(_params(event_id="evt-dup"))

    assert result.duplicate is True
    assert result.reserved is False
    assert repo.reserve_calls == 0  # never attempted a reservation
    assert repo.stock == {"SKU-A": 5, "SKU-B": 3}
    assert publisher.calls == []  # no event re-published
