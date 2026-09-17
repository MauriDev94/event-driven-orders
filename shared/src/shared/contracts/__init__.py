"""Integration event contracts shared across services.

These Pydantic models are the wire format exchanged through the broker.
Each service maps between its own domain and these contracts — services
never share domain entities, only these explicit integration events.
"""

from shared.contracts.base_event import BaseEvent
from shared.contracts.inventory_events import StockRejected, StockReserved
from shared.contracts.order_events import (
    OrderConfirmed,
    OrderCreated,
    OrderItem,
    OrderRejected,
)

__all__ = [
    "BaseEvent",
    "OrderCreated",
    "OrderConfirmed",
    "OrderRejected",
    "OrderItem",
    "StockReserved",
    "StockRejected",
]
