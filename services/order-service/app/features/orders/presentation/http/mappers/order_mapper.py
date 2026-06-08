"""HTTP <-> application mappers for the orders feature.

Pure data shaping, zero business logic: request schema -> use case params,
and domain entity -> response schema.
"""

from app.features.orders.application.usecases.create_order_use_case import (
    CreateOrderLineParams,
    CreateOrderParams,
)
from app.features.orders.domain.entities.order import Order
from app.features.orders.presentation.http.schemas.order_schemas import (
    CreateOrderRequest,
    OrderLineResponse,
    OrderResponse,
)


def to_create_params(request: CreateOrderRequest) -> CreateOrderParams:
    return CreateOrderParams(
        customer_id=request.customer_id,
        lines=[
            CreateOrderLineParams(
                product_id=line.product_id,
                quantity=line.quantity,
                unit_price=line.unit_price,
            )
            for line in request.lines
        ],
    )


def to_order_response(order: Order) -> OrderResponse:
    return OrderResponse(
        id=order.id or "",
        customer_id=order.customer_id,
        status=order.status.value,
        lines=[
            OrderLineResponse(
                product_id=line.product_id,
                quantity=line.quantity,
                unit_price=line.unit_price,
            )
            for line in order.lines
        ],
        total_amount=order.total_amount,
        rejection_reason=order.rejection_reason,
        created_at=order.created_at,
        updated_at=order.updated_at,
    )
