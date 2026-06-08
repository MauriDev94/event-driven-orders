from typing import Annotated

from fastapi import Depends, status

from app.core.router.router import get_versioned_router
from app.features.orders.application.usecases.create_order_use_case import CreateOrder
from app.features.orders.application.usecases.get_order_use_case import GetOrder
from app.features.orders.di.dependencies import (
    get_create_order_use_case,
    get_get_order_use_case,
)
from app.features.orders.presentation.http.mappers.order_mapper import (
    to_create_params,
    to_order_response,
)
from app.features.orders.presentation.http.schemas.order_schemas import (
    CreateOrderRequest,
    OrderResponse,
)

router = get_versioned_router("v1")


@router.post(
    "/orders",
    response_model=OrderResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["orders"],
    summary="Create an order and publish OrderCreated",
)
async def create_order(
    request: CreateOrderRequest,
    use_case: Annotated[CreateOrder, Depends(get_create_order_use_case)],
) -> OrderResponse:
    order = await use_case.execute(to_create_params(request))
    return to_order_response(order)


@router.get(
    "/orders/{order_id}",
    response_model=OrderResponse,
    status_code=status.HTTP_200_OK,
    tags=["orders"],
    summary="Fetch an order by id",
)
async def get_order(
    order_id: str,
    use_case: Annotated[GetOrder, Depends(get_get_order_use_case)],
) -> OrderResponse:
    order = use_case.execute(order_id)
    return to_order_response(order)
