from app.common.use_case import UseCase
from app.core.exceptions.exceptions import NotFoundError
from app.features.orders.application.contracts.order_repository import OrderRepository
from app.features.orders.domain.entities.order import Order


class GetOrder(UseCase[str, Order]):
    """Fetch a single order by id, or fail with a domain ``NotFoundError``."""

    def __init__(self, order_repository: OrderRepository) -> None:
        self.order_repository = order_repository

    def execute(self, params: str) -> Order:
        order = self.order_repository.get_by_id(params)
        if order is None:
            raise NotFoundError("order not found")
        return order
