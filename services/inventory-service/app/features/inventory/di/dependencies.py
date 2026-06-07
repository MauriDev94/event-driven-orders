from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.core.messaging.connection import RabbitMQConnection
from app.core.providers.db import get_db_session
from app.features.inventory.application.contracts.event_publisher import EventPublisher
from app.features.inventory.application.contracts.inventory_repository import (
    InventoryRepository,
)
from app.features.inventory.application.usecases.reserve_stock_use_case import ReserveStock
from app.features.inventory.infrastructure.messaging.aio_pika_event_publisher import (
    AioPikaEventPublisher,
)
from app.features.inventory.infrastructure.repositories.inventory_repository import (
    SqlAlchemyInventoryRepository,
)


def get_inventory_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> InventoryRepository:
    """Provide the SQLAlchemy-backed inventory repository (returns the port type)."""
    return SqlAlchemyInventoryRepository(session=session)


def get_event_publisher(request: Request) -> EventPublisher:
    """Provide the aio-pika event publisher built from the app's broker connection."""
    broker: RabbitMQConnection = request.app.state.broker
    return AioPikaEventPublisher(connection=broker)


def get_reserve_stock_use_case(
    inventory_repository: Annotated[InventoryRepository, Depends(get_inventory_repository)],
    event_publisher: Annotated[EventPublisher, Depends(get_event_publisher)],
) -> ReserveStock:
    """Provide the ReserveStock use case."""
    return ReserveStock(
        inventory_repository=inventory_repository, event_publisher=event_publisher
    )
