from uuid import uuid4

from app.features.orders.domain.entities.order import Order, OrderLine, OrderStatus
from app.features.orders.infrastructure.models.order_model import (
    OrderLineModel,
    OrderModel,
)


def map_order_model_to_entity(model: OrderModel) -> Order:
    """Convert an ORM model (with its lines) into a domain entity."""
    return Order(
        id=model.id,
        customer_id=model.customer_id,
        lines=[
            OrderLine(
                product_id=line.product_id,
                quantity=line.quantity,
                unit_price=line.unit_price,
            )
            for line in model.lines
        ],
        status=OrderStatus(model.status),
        rejection_reason=model.rejection_reason,
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


def map_order_entity_to_model(entity: Order) -> OrderModel:
    """Convert a domain entity into a new ORM model graph."""
    order_id = entity.id or str(uuid4())
    return OrderModel(
        id=order_id,
        customer_id=entity.customer_id,
        status=entity.status.value,
        rejection_reason=entity.rejection_reason,
        lines=[
            OrderLineModel(
                id=str(uuid4()),
                order_id=order_id,
                product_id=line.product_id,
                quantity=line.quantity,
                unit_price=line.unit_price,
            )
            for line in entity.lines
        ],
    )
