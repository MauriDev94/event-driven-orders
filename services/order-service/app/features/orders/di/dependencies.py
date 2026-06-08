from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.core.messaging.connection import RabbitMQConnection
from app.core.providers.db import get_db_session
from app.features.orders.application.contracts.event_publisher import EventPublisher
from app.features.orders.application.contracts.order_repository import OrderRepository
from app.features.orders.application.usecases.create_order_use_case import CreateOrder
from app.features.orders.application.usecases.get_order_use_case import GetOrder
from app.features.orders.infrastructure.messaging.aio_pika_event_publisher import (
    AioPikaEventPublisher,
)
from app.features.orders.infrastructure.repositories.order_repository import (
    SqlAlchemyOrderRepository,
)


def get_order_repository(
    session: Annotated[Session, Depends(get_db_session)],
) -> OrderRepository:
    """Provide the SQLAlchemy-backed order repository (returns the port type)."""
    return SqlAlchemyOrderRepository(session=session)


def get_event_publisher(request: Request) -> EventPublisher:
    """Provide the aio-pika event publisher built from the app's broker connection."""
    broker: RabbitMQConnection = request.app.state.broker
    return AioPikaEventPublisher(connection=broker)


def get_create_order_use_case(
    order_repository: Annotated[OrderRepository, Depends(get_order_repository)],
    event_publisher: Annotated[EventPublisher, Depends(get_event_publisher)],
) -> CreateOrder:
    """Provide the CreateOrder use case."""
    return CreateOrder(order_repository=order_repository, event_publisher=event_publisher)


def get_get_order_use_case(
    order_repository: Annotated[OrderRepository, Depends(get_order_repository)],
) -> GetOrder:
    """Provide the GetOrder use case."""
    return GetOrder(order_repository=order_repository)
