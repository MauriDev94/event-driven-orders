from dataclasses import dataclass

from app.common.use_case import AsyncUseCase
from app.core.exceptions.exceptions import NotFoundError
from app.core.messaging.topology import ROUTING_ORDER_CONFIRMED
from app.features.orders.application.contracts.event_publisher import EventPublisher
from app.features.orders.application.contracts.unit_of_work import OrderUnitOfWork
from app.features.orders.application.mappers.order_event_mapper import map_order_to_order_confirmed


@dataclass
class ConfirmOrderParams:
    order_id: str
    event_id: str
    correlation_id: str


@dataclass
class ConfirmOrderResult:
    order_id: str
    customer_id: str | None = None
    duplicate: bool = False


class ConfirmOrder(AsyncUseCase[ConfirmOrderParams, ConfirmOrderResult]):
    """Confirm an order after stock has been reserved.

    Idempotency: ``event_id`` is recorded atomically with the status change.
    A redelivered ``StockReserved`` (same event_id) is detected as a duplicate
    and ACKed without re-confirming or re-publishing.

    Publish-after-commit: ``OrderConfirmed`` is published only after the
    transaction commits, keeping the dual-write window as narrow as possible.
    """

    def __init__(self, unit_of_work: OrderUnitOfWork, event_publisher: EventPublisher) -> None:
        self.unit_of_work = unit_of_work
        self.event_publisher = event_publisher

    async def execute(self, params: ConfirmOrderParams) -> ConfirmOrderResult:
        result = self._run_transaction(params)

        if result.duplicate:
            return result

        event = map_order_to_order_confirmed(
            order_id=result.order_id,
            customer_id=result.customer_id or "",
            correlation_id=params.correlation_id,
        )
        await self.event_publisher.publish(event, ROUTING_ORDER_CONFIRMED)
        return result

    def _run_transaction(self, params: ConfirmOrderParams) -> ConfirmOrderResult:
        with self.unit_of_work as uow:
            if not uow.register_event(params.event_id):
                return ConfirmOrderResult(order_id=params.order_id, duplicate=True)

            order = uow.get_order(params.order_id)
            if order is None:
                raise NotFoundError(f"order {params.order_id} not found")

            order.confirm()
            uow.save_order(order)
            uow.commit()

        return ConfirmOrderResult(order_id=order.id or "", customer_id=order.customer_id)
