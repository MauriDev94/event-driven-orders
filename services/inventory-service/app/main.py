import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from prometheus_fastapi_instrumentator import Instrumentator
from shared.messaging.connection import RabbitMQConnection, connect_with_retry
from shared.messaging.retry_dispatcher import wrap_with_retry
from shared.observability.config import configure_logging
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.core.config.env_config import EnvConfig
from app.core.exceptions.error_handling import register_exception_handlers
from app.core.messaging.topology import ORDER_CREATED_QUEUE, declare_topology
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

SERVICE_NAME = "inventory-service"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Worker lifespan: open the broker connection, declare topology, and start
    consuming ``OrderCreated``. A minimal FastAPI app serves ``/health`` for
    the container probe — this service has no public REST API.

    Cold start: if the broker is not reachable yet, ``connect_with_retry``
    retries with exponential backoff for a few attempts before giving up. If
    it still cannot connect, a background task keeps retrying indefinitely
    (capped backoff) and finishes the setup once the broker comes up — the
    process never needs a manual restart. ``connect_robust`` then handles any
    later disconnection on its own, re-declaring topology and consumers.

    Broker failures are resilient: ``/health`` reports the broker as degraded
    but the process stays up so Kubernetes/Compose can track the state.
    """
    config = get_env_config()
    broker = RabbitMQConnection(config.rabbitmq_url)
    app.state.broker = broker
    app.state.broker_watchdog = None

    if await connect_with_retry(broker.connect, service_name=SERVICE_NAME):
        await _start_consuming(app, broker, config)
    else:
        app.state.broker_watchdog = asyncio.create_task(_reconnect_and_start(app, broker, config))

    yield

    if app.state.broker_watchdog is not None:
        app.state.broker_watchdog.cancel()
    await broker.close()


async def _reconnect_and_start(app: FastAPI, broker: RabbitMQConnection, config: EnvConfig) -> None:
    """Background watchdog: keep retrying the initial connection forever
    (capped backoff) and finish startup once it succeeds."""
    await connect_with_retry(broker.connect, service_name=SERVICE_NAME, max_attempts=None)
    await _start_consuming(app, broker, config)


async def _start_consuming(app: FastAPI, broker: RabbitMQConnection, config: EnvConfig) -> None:
    """Declare topology and start consuming ``OrderCreated``. Any failure
    here is logged and leaves the service in degraded mode rather than
    crashing the process."""
    try:
        await declare_topology(broker.channel)

        publisher = AioPikaEventPublisher(broker)
        db = _build_session_factory(config)
        uow = SqlAlchemyUnitOfWork(db)
        use_case = ReserveStock(uow, publisher)
        handler = build_order_created_handler(use_case)

        resilient_handler = wrap_with_retry(
            handler, channel=broker.channel, main_queue_name=ORDER_CREATED_QUEUE
        )
        queue = await broker.channel.get_queue(ORDER_CREATED_QUEUE)
        await queue.consume(resilient_handler)
        logger.info("%s connected to broker and consuming OrderCreated", SERVICE_NAME)
    except Exception as exc:  # noqa: BLE001 - startup must stay resilient
        logger.warning("%s could not start consuming from broker: %s", SERVICE_NAME, exc)


def _build_session_factory(config: EnvConfig) -> sessionmaker:  # type: ignore[type-arg]
    from app.core.data.source.local.database import Database

    return Database(config).session


configure_logging(SERVICE_NAME)

app = FastAPI(title="inventory-service", version="0.1.0", lifespan=lifespan)
Instrumentator().instrument(app).expose(app)

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
