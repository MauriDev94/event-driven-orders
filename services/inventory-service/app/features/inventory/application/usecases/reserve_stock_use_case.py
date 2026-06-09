from dataclasses import dataclass
from enum import Enum, auto

from app.common.use_case import AsyncUseCase
from app.core.messaging.topology import ROUTING_STOCK_REJECTED, ROUTING_STOCK_RESERVED
from app.features.inventory.application.contracts.event_publisher import EventPublisher
from app.features.inventory.application.contracts.inventory_repository import (
    ReservationItem,
)
from app.features.inventory.application.contracts.unit_of_work import UnitOfWork
from app.features.inventory.application.mappers.stock_event_mapper import (
    map_to_stock_rejected,
    map_to_stock_reserved,
)


@dataclass
class ReserveStockItem:
    """A requested reservation line. ``product_id`` is the catalog id carried by
    ``OrderCreated`` — it matches a product's ``sku`` in this service."""

    product_id: str
    quantity: int


@dataclass
class ReserveStockParams:
    order_id: str
    event_id: str
    correlation_id: str
    items: list[ReserveStockItem]


@dataclass
class ReserveStockResult:
    order_id: str
    reserved: bool
    reason: str | None = None
    duplicate: bool = False


class _Outcome(Enum):
    """Result of the (synchronous) reservation transaction."""

    DUPLICATE = auto()
    RESERVED = auto()
    REJECTED = auto()


class ReserveStock(AsyncUseCase[ReserveStockParams, ReserveStockResult]):
    """Reserve stock for an order and publish StockReserved/StockRejected.

    Orchestration only. Two patterns carry this use case:

    1. **Idempotency.** RabbitMQ is at-least-once, so the same ``OrderCreated``
       can arrive twice. ``event_id`` is recorded inside the reservation
       transaction; a duplicate is skipped without re-reserving or re-publishing.
    2. **Atomic, all-or-nothing reservation.** Every line is decremented with a
       conditional ``UPDATE`` (anti race-condition); if any line falls short,
       all decrements roll back and the order is rejected.

    The DB work runs in one transaction (Unit of Work); the event is published
    *after* commit (publish-after-commit, same MVP stance as order-service).
    A rejected order still records its ``event_id`` so a redelivery does not
    re-publish the rejection.
    """

    def __init__(
        self,
        unit_of_work: UnitOfWork,
        event_publisher: EventPublisher,
    ) -> None:
        self.unit_of_work = unit_of_work
        self.event_publisher = event_publisher

    async def execute(self, params: ReserveStockParams) -> ReserveStockResult:
        outcome, failed_sku = self._run_transaction(params)

        if outcome is _Outcome.DUPLICATE:
            return ReserveStockResult(order_id=params.order_id, reserved=False, duplicate=True)

        if outcome is _Outcome.RESERVED:
            event = map_to_stock_reserved(params.order_id, params.correlation_id)
            await self.event_publisher.publish(event, ROUTING_STOCK_RESERVED)
            return ReserveStockResult(order_id=params.order_id, reserved=True)

        reason = f"insufficient stock for product {failed_sku}"
        rejected = map_to_stock_rejected(params.order_id, params.correlation_id, reason)
        await self.event_publisher.publish(rejected, ROUTING_STOCK_REJECTED)
        return ReserveStockResult(order_id=params.order_id, reserved=False, reason=reason)

    def _run_transaction(self, params: ReserveStockParams) -> tuple[_Outcome, str | None]:
        """Run the idempotency check + reservation in a single transaction.

        Kept synchronous and separate from publishing so the transaction never
        spans an ``await`` on the broker.
        """
        with self.unit_of_work as uow:
            if not uow.inventory.register_event(params.event_id):
                return _Outcome.DUPLICATE, None

            items = [ReservationItem(sku=i.product_id, quantity=i.quantity) for i in params.items]
            failed_sku = uow.inventory.reserve_all(items)
            # Commit either way: a successful reservation persists the decrements
            # and the event record together; a rejection persists only the event
            # record (reserve_all already rolled back its partial decrements).
            uow.commit()

        if failed_sku is None:
            return _Outcome.RESERVED, None
        return _Outcome.REJECTED, failed_sku
