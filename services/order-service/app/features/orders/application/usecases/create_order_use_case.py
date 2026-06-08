from dataclasses import dataclass
from decimal import Decimal

from app.common.use_case import AsyncUseCase
from app.core.messaging.topology import ROUTING_ORDER_CREATED
from app.features.orders.application.contracts.event_publisher import EventPublisher
from app.features.orders.application.contracts.order_repository import OrderRepository
from app.features.orders.application.mappers.order_event_mapper import (
    map_order_to_order_created,
)
from app.features.orders.domain.entities.order import Order, OrderLine


@dataclass
class CreateOrderLineParams:
    product_id: str
    quantity: int
    unit_price: Decimal


@dataclass
class CreateOrderParams:
    customer_id: str
    lines: list[CreateOrderLineParams]


class CreateOrder(AsyncUseCase[CreateOrderParams, Order]):
    """Create an order and publish ``OrderCreated``.

    Orchestration only — the domain enforces its own invariants:
    1. Build the ``Order`` aggregate (starts ``pending``).
    2. Persist it (the repository commits and assigns the id).
    3. Publish ``OrderCreated`` to the ``orders`` exchange.

    Consistency (MVP): publish-after-commit. The order is committed first,
    then the event is published. This leaves a dual-write window — if the
    publish fails, the order exists but no event was emitted. Acceptable for
    the MVP; the hardening is a transactional outbox (Phase 2+).
    """

    def __init__(
        self,
        order_repository: OrderRepository,
        event_publisher: EventPublisher,
    ) -> None:
        self.order_repository = order_repository
        self.event_publisher = event_publisher

    async def execute(self, params: CreateOrderParams) -> Order:
        order = Order(
            id=None,
            customer_id=params.customer_id,
            lines=[
                OrderLine(
                    product_id=line.product_id,
                    quantity=line.quantity,
                    unit_price=line.unit_price,
                )
                for line in params.lines
            ],
        )

        persisted = self.order_repository.add(order)

        event = map_order_to_order_created(persisted)
        await self.event_publisher.publish(event, ROUTING_ORDER_CREATED)

        return persisted
