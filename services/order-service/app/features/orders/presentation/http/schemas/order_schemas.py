from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.common.identifiers import ID_MAX_LENGTH, ID_PATTERN

# Request/response contracts for the orders HTTP API.

# Lines per order. assistant-service bounds `items` of order.created to the same
# number, so an order accepted here is never dead-lettered there; raise both
# together. A real order has a handful of lines, and each one is a row, an
# event item and, for the assistant, text the model may read.
MAX_ORDER_LINES = 50


class OrderLineRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: str = Field(..., min_length=1, max_length=ID_MAX_LENGTH, pattern=ID_PATTERN)
    quantity: int = Field(..., gt=0)
    unit_price: Decimal = Field(..., ge=0)


class CreateOrderRequest(BaseModel):
    # The customer is the token's `sub`, never a body field (ADR-0027):
    # sending `customer_id` is a 422.
    model_config = ConfigDict(extra="forbid")

    lines: list[OrderLineRequest] = Field(..., min_length=1, max_length=MAX_ORDER_LINES)


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
