from dataclasses import dataclass
from decimal import Decimal

from app.common.use_case import UseCase
from app.features.orders.application.contracts.event_publisher import EventPublisher
from app.features.orders.application.contracts.order_repository import OrderRepository


@dataclass
class CreateOrderLineParams:
    product_id: str
    quantity: int
    unit_price: Decimal


@dataclass
class CreateOrderParams:
    customer_id: str
    lines: list[CreateOrderLineParams]


@dataclass
class CreateOrderResult:
    order_id: str
    status: str


class CreateOrder(UseCase[CreateOrderParams, CreateOrderResult]):
    """Create an order and publish ``OrderCreated``.

    SCAFFOLD STUB: wiring is in place (repository + publisher ports injected)
    but the orchestration body is implemented in Phase 1.
    """

    def __init__(
        self,
        order_repository: OrderRepository,
        event_publisher: EventPublisher,
    ) -> None:
        self.order_repository = order_repository
        self.event_publisher = event_publisher

    def execute(self, params: CreateOrderParams) -> CreateOrderResult:
        raise NotImplementedError("CreateOrder is implemented in Phase 1")
