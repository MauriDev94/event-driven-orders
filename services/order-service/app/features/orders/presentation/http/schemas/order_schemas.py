from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field

# Request/response contracts for the orders HTTP API.

# Customer and product ids are plain identifiers, never free text. They flow
# into varchar(36) columns, into every event, into the recipient address that
# notification-service builds (``<customer_id>@example.com``) and, through
# assistant-service's read model, into what the LLM reads. Rejecting anything
# else here keeps prompt-injection text out of the model's context and turns
# an oversized id into a 422 instead of a database error.
ID_MAX_LENGTH = 36
ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]*$"


class OrderLineRequest(BaseModel):
    product_id: str = Field(..., min_length=1, max_length=ID_MAX_LENGTH, pattern=ID_PATTERN)
    quantity: int = Field(..., gt=0)
    unit_price: Decimal = Field(..., ge=0)


class CreateOrderRequest(BaseModel):
    customer_id: str = Field(..., min_length=1, max_length=ID_MAX_LENGTH, pattern=ID_PATTERN)
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
