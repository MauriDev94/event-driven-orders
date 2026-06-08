from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field

# Request/response contracts for the orders HTTP API.


class OrderLineRequest(BaseModel):
    product_id: str = Field(..., min_length=1)
    quantity: int = Field(..., gt=0)
    unit_price: Decimal = Field(..., ge=0)


class CreateOrderRequest(BaseModel):
    customer_id: str = Field(..., min_length=1)
    lines: list[OrderLineRequest] = Field(..., min_length=1)


class OrderLineResponse(BaseModel):
    product_id: str
    quantity: int
    unit_price: Decimal


class OrderResponse(BaseModel):
    id: str
    customer_id: str
    status: str
    lines: list[OrderLineResponse]
    total_amount: Decimal
    rejection_reason: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
