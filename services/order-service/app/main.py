import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from shared.messaging.connection import RabbitMQConnection, connect_with_retry
from shared.messaging.retry_dispatcher import wrap_with_retry
from shared.observability.config import configure_logging
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.core.config.env_config import EnvConfig
from app.core.exceptions.error_handling import register_exception_handlers
from app.core.messaging.topology import ORDER_RESULTS_QUEUE, declare_topology
from app.core.middleware.correlation_id import correlation_id_middleware
from app.core.providers.db import get_db_session
from app.core.providers.env_config import get_env_config
from app.features.orders.application.usecases.confirm_order_use_case import ConfirmOrder
from app.features.orders.application.usecases.reject_order_use_case import RejectOrder
from app.features.orders.infrastructure.messaging.aio_pika_event_publisher import (
    AioPikaEventPublisher,
)
from app.features.orders.infrastructure.persistence.sqlalchemy_order_unit_of_work import (
    SqlAlchemyOrderUnitOfWork,
)
from app.features.orders.presentation.consumers.inventory_results_consumer import (
    build_inventory_result_handler,
)
from app.features.orders.presentation.http.router import router as orders_router

logger = logging.getLogger(__name__)

SERVICE_NAME = "order-service"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the broker connection on startup, declare topology, and start
    consuming inventory results (StockReserved / StockRejected).

    Cold start: if the broker is not reachable yet, ``connect_with_retry``
    retries with exponential backoff for a few attempts before giving up. If
    it still cannot connect, a background task keeps retrying indefinitely
    (capped backoff) and finishes the setup once the broker comes up — the
    process never needs a manual restart. ``connect_robust`` then handles any
    later disconnection on its own, re-declaring topology and consumers.

    A failed broker connection must NOT crash the app: ``/health`` reports
    the broker as unhealthy instead.
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
    """Declare topology and start consuming inventory results. Any failure
    here is logged and leaves the service in degraded mode rather than
    crashing the process."""
    try:
        await declare_topology(broker.channel)

        publisher = AioPikaEventPublisher(broker)
        db = _build_session_factory(config)
        confirm_uc = ConfirmOrder(SqlAlchemyOrderUnitOfWork(db), publisher)
        reject_uc = RejectOrder(SqlAlchemyOrderUnitOfWork(db), publisher)
        handler = build_inventory_result_handler(confirm_uc, reject_uc)

        resilient_handler = wrap_with_retry(
            handler, channel=broker.channel, main_queue_name=ORDER_RESULTS_QUEUE
        )
        queue = await broker.channel.get_queue(ORDER_RESULTS_QUEUE)
        await queue.consume(resilient_handler)
        logger.info("%s connected to broker and consuming inventory results", SERVICE_NAME)
    except Exception as exc:  # noqa: BLE001 - startup must stay resilient
        logger.warning("%s could not start consuming from broker: %s", SERVICE_NAME, exc)


def _build_session_factory(config: EnvConfig) -> sessionmaker:  # type: ignore[type-arg]
    from app.core.data.source.local.database import Database

    return Database(config).session


configure_logging(SERVICE_NAME)

app = FastAPI(title="order-service", version="0.1.0", lifespan=lifespan)
app.middleware("http")(correlation_id_middleware)
register_exception_handlers(app)
app.include_router(orders_router)


@app.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    """Deep health check: verifies database and broker connectivity.

    Always returns 200 so the probe distinguishes "process up" from
    "dependency degraded" via the body rather than the status code.
    """
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
        "service": "order-service",
        "database": db_status,
        "broker": broker_status,
    }
