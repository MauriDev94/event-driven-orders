from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import sessionmaker

from app.core.messaging.connection import RabbitMQConnection
from app.features.inventory.application.contracts.event_publisher import EventPublisher
from app.features.inventory.application.contracts.unit_of_work import UnitOfWork
from app.features.inventory.application.usecases.reserve_stock_use_case import ReserveStock
from app.features.inventory.infrastructure.messaging.aio_pika_event_publisher import (
    AioPikaEventPublisher,
)
from app.features.inventory.infrastructure.persistence.sqlalchemy_unit_of_work import (
    SqlAlchemyUnitOfWork,
)


def get_event_publisher(request: Request) -> EventPublisher:
    """Provide the aio-pika event publisher built from the app's broker connection."""
    broker: RabbitMQConnection = request.app.state.broker
    return AioPikaEventPublisher(connection=broker)


def get_unit_of_work(request: Request) -> UnitOfWork:
    """Provide a Unit of Work bound to the app's DB session factory."""
    factory: sessionmaker = request.app.state.session_factory  # type: ignore[type-arg]
    return SqlAlchemyUnitOfWork(factory)


def get_reserve_stock_use_case(
    unit_of_work: Annotated[UnitOfWork, Depends(get_unit_of_work)],
    event_publisher: Annotated[EventPublisher, Depends(get_event_publisher)],
) -> ReserveStock:
    """Provide the ReserveStock use case."""
    return ReserveStock(unit_of_work=unit_of_work, event_publisher=event_publisher)
