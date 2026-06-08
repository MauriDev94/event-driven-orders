from dataclasses import dataclass

from app.common.use_case import UseCase
from app.features.inventory.application.contracts.event_publisher import EventPublisher
from app.features.inventory.application.contracts.inventory_repository import (
    InventoryRepository,
)


@dataclass
class ReserveStockItem:
    product_id: str
    quantity: int


@dataclass
class ReserveStockParams:
    order_id: str
    correlation_id: str
    items: list[ReserveStockItem]


@dataclass
class ReserveStockResult:
    order_id: str
    reserved: bool
    reason: str | None = None


class ReserveStock(UseCase[ReserveStockParams, ReserveStockResult]):
    """Reserve stock for an order and publish StockReserved/StockRejected.

    SCAFFOLD STUB: ports are injected; the atomic reservation + idempotency
    logic lands in Phase 2.
    """

    def __init__(
        self,
        inventory_repository: InventoryRepository,
        event_publisher: EventPublisher,
    ) -> None:
        self.inventory_repository = inventory_repository
        self.event_publisher = event_publisher

    def execute(self, params: ReserveStockParams) -> ReserveStockResult:
        raise NotImplementedError("ReserveStock is implemented in Phase 2")
