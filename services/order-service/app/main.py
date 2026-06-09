import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.core.exceptions.error_handling import register_exception_handlers
from app.core.messaging.connection import RabbitMQConnection
from app.core.messaging.topology import ORDER_RESULTS_QUEUE, declare_topology
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the broker connection on startup, declare topology, and start
    consuming inventory results (StockReserved / StockRejected).

    A failed broker connection must NOT crash the app: ``/health`` reports
    the broker as unhealthy instead. On a successful connection the orders
    topology (exchanges, queues, bindings) is declared — declaration is
    idempotent on RabbitMQ, so it is safe to run on every startup.
    """
    config = get_env_config()
    broker = RabbitMQConnection(config.rabbitmq_url)
    try:
        await broker.connect()
        await declare_topology(broker.channel)

        publisher = AioPikaEventPublisher(broker)
        db = _build_session_factory(config)
        confirm_uc = ConfirmOrder(SqlAlchemyOrderUnitOfWork(db), publisher)
        reject_uc = RejectOrder(SqlAlchemyOrderUnitOfWork(db), publisher)
        handler = build_inventory_result_handler(confirm_uc, reject_uc)

        queue = await broker.channel.get_queue(ORDER_RESULTS_QUEUE)
        await queue.consume(handler)
        logger.info("order-service connected to broker and consuming inventory results")
    except Exception as exc:  # noqa: BLE001 - startup must stay resilient
        logger.warning("order-service could not connect to broker: %s", exc)
    app.state.broker = broker
    yield
    await broker.close()


def _build_session_factory(config) -> sessionmaker:  # type: ignore[type-arg]
    from app.core.data.source.local.database import Database

    return Database(config).session


app = FastAPI(title="order-service", version="0.1.0", lifespan=lifespan)
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
