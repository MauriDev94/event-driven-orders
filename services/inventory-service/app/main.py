import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from shared.messaging.retry_dispatcher import wrap_with_retry
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.core.exceptions.error_handling import register_exception_handlers
from app.core.messaging.connection import RabbitMQConnection
from app.core.messaging.topology import declare_topology
from app.core.providers.db import get_db_session
from app.core.providers.env_config import get_env_config
from app.features.inventory.application.usecases.reserve_stock_use_case import ReserveStock
from app.features.inventory.infrastructure.messaging.aio_pika_event_publisher import (
    AioPikaEventPublisher,
)
from app.features.inventory.infrastructure.persistence.sqlalchemy_unit_of_work import (
    SqlAlchemyUnitOfWork,
)
from app.features.inventory.presentation.consumers.order_created_consumer import (
    build_order_created_handler,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Worker lifespan: open the broker connection, declare topology, and start
    consuming ``OrderCreated``. A minimal FastAPI app serves ``/health`` for
    the container probe — this service has no public REST API.

    Broker failures are resilient: ``/health`` reports the broker as degraded
    but the process stays up so Kubernetes/Compose can track the state.
    """
    config = get_env_config()
    broker = RabbitMQConnection(config.rabbitmq_url)
    try:
        await broker.connect()
        await declare_topology(broker.channel)

        publisher = AioPikaEventPublisher(broker)
        db = _build_session_factory(config)
        uow = SqlAlchemyUnitOfWork(db)
        use_case = ReserveStock(uow, publisher)
        handler = build_order_created_handler(use_case)

        from app.core.messaging.topology import ORDER_CREATED_QUEUE

        resilient_handler = wrap_with_retry(
            handler, channel=broker.channel, main_queue_name=ORDER_CREATED_QUEUE
        )
        queue = await broker.channel.get_queue(ORDER_CREATED_QUEUE)
        await queue.consume(resilient_handler)
        logger.info("inventory-service connected to broker and consuming OrderCreated")
    except Exception as exc:  # noqa: BLE001 - startup must stay resilient
        logger.warning("inventory-service could not connect to broker: %s", exc)
    app.state.broker = broker
    yield
    await broker.close()


def _build_session_factory(config) -> sessionmaker:  # type: ignore[type-arg]
    from app.core.data.source.local.database import Database

    return Database(config).session


app = FastAPI(title="inventory-service", version="0.1.0", lifespan=lifespan)
register_exception_handlers(app)


@app.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    """Deep health check: database + broker. Always returns 200."""
    db_status = "healthy"
    try:
        session_gen = get_db_session()
        session = next(session_gen)
        session.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001 - health must never raise
        db_status = "unhealthy"

    broker = getattr(app.state, "broker", None)
    broker_status = "healthy" if broker is not None and broker.is_connected else "unhealthy"

    return {
        "status": "ok",
        "service": "inventory-service",
        "database": db_status,
        "broker": broker_status,
    }
