from datetime import UTC, datetime
from uuid import uuid4

from pydantic import BaseModel, Field


class BaseEvent(BaseModel):
    """Base envelope for every integration event published to the broker.

    Carries the metadata needed for tracing, idempotency and routing:
    - ``event_id``: unique id of this specific message (idempotency key).
    - ``event_type``: discriminator used by consumers to route handling.
    - ``occurred_at``: UTC timestamp of when the event happened.
    - ``correlation_id``: ties together all events of a single business
      flow (e.g. one order's lifecycle) for end-to-end tracing.

    Concrete events subclass this and pin ``event_type`` with a default.
    """

    event_id: str = Field(default_factory=lambda: str(uuid4()))
    event_type: str
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    correlation_id: str
