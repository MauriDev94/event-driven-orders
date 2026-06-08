from decimal import Decimal

from pydantic import BaseModel, Field

# SCAFFOLD: request/response contracts for the orders HTTP API.
# The POST /orders endpoint that uses them is implemented in Phase 1.


class OrderLineRequest(BaseModel):
    product_id: str = Field(..., min_length=1)
    quantity: int = Field(..., gt=0)
    unit_price: Decimal = Field(..., ge=0)


class CreateOrderRequest(BaseModel):
    customer_id: str = Field(..., min_length=1)
    lines: list[OrderLineRequest] = Field(..., min_length=1)


class CreateOrderResponse(BaseModel):
    order_id: str
    status: str
