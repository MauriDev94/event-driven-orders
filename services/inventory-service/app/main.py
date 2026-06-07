import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text

from app.core.exceptions.error_handling import register_exception_handlers
from app.core.messaging.connection import RabbitMQConnection
from app.core.providers.db import get_db_session
from app.core.providers.env_config import get_env_config

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Worker lifespan: open the broker connection and (in later phases) start
    consuming ``OrderCreated``. A minimal FastAPI app is exposed only to serve
    ``/health`` for the container probe — this service has no public REST API.
    """
    config = get_env_config()
    broker = RabbitMQConnection(config.rabbitmq_url)
    try:
        await broker.connect()
        logger.info("inventory-service connected to broker")
        # Phase 2: declare topology and start the OrderCreated consumer here.
    except Exception as exc:  # noqa: BLE001 - startup must stay resilient
        logger.warning("inventory-service could not connect to broker: %s", exc)
    app.state.broker = broker
    yield
    await broker.close()


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
