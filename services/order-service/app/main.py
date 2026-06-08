import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text

from app.core.exceptions.error_handling import register_exception_handlers
from app.core.messaging.connection import RabbitMQConnection
from app.core.messaging.topology import declare_topology
from app.core.providers.db import get_db_session
from app.core.providers.env_config import get_env_config
from app.features.orders.presentation.http.router import router as orders_router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the broker connection on startup, close it on shutdown.

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
        logger.info("order-service connected to broker and declared topology")
    except Exception as exc:  # noqa: BLE001 - startup must stay resilient
        logger.warning("order-service could not connect to broker: %s", exc)
    app.state.broker = broker
    yield
    await broker.close()


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
