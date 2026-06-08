from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.exceptions.exceptions import DatabaseError, NotFoundError
from app.features.orders.application.contracts.order_repository import OrderRepository
from app.features.orders.domain.entities.order import Order
from app.features.orders.infrastructure.mappers.order_mapper import (
    map_order_entity_to_model,
    map_order_model_to_entity,
)
from app.features.orders.infrastructure.models.order_model import OrderModel


class SqlAlchemyOrderRepository(OrderRepository):
    """SQLAlchemy implementation of the OrderRepository port."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def add(self, order: Order) -> Order:
        model = map_order_entity_to_model(order)
        try:
            self.session.add(model)
            self.session.commit()
            self.session.refresh(model)
        except SQLAlchemyError as exc:
            self.session.rollback()
            raise DatabaseError("failed to create order") from exc
        return map_order_model_to_entity(model)

    def get_by_id(self, order_id: str) -> Order | None:
        try:
            model = self.session.query(OrderModel).filter(OrderModel.id == order_id).first()
        except SQLAlchemyError as exc:
            raise DatabaseError("failed to retrieve order") from exc
        return map_order_model_to_entity(model) if model is not None else None

    def update(self, order: Order) -> Order:
        if order.id is None:
            raise NotFoundError("order not found")
        try:
            model = self.session.query(OrderModel).filter(OrderModel.id == order.id).first()
            if model is None:
                raise NotFoundError("order not found")
            model.status = order.status.value
            model.rejection_reason = order.rejection_reason
            self.session.commit()
            self.session.refresh(model)
        except SQLAlchemyError as exc:
            self.session.rollback()
            raise DatabaseError("failed to update order") from exc
        return map_order_model_to_entity(model)
