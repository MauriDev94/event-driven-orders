from dataclasses import dataclass

from app.common.use_case import UseCase
from app.core.exceptions.exceptions import NotFoundError
from app.features.orders.application.contracts.order_repository import OrderRepository
from app.features.orders.domain.entities.order import Order


@dataclass
class GetOrderParams:
    order_id: str
    customer_id: str


class GetOrder(UseCase[GetOrderParams, Order]):
    """Fetch an order of the given customer, or fail with ``NotFoundError``.

    Someone else's order raises the same error, with the same message, as a
    missing one, so the API never confirms that an id exists (ADR-0027). The
    rule is this use case's; the repository applies the filter in its query,
    so both cases also cost one query and can't be told apart by timing.
    """

    def __init__(self, order_repository: OrderRepository) -> None:
        self.order_repository = order_repository

    def execute(self, params: GetOrderParams) -> Order:
        order = self.order_repository.get_by_id_for_customer(params.order_id, params.customer_id)
        if order is None or order.customer_id != params.customer_id:
            raise NotFoundError("order not found")
        return order
