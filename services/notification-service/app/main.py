import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.exceptions.error_handling import register_exception_handlers
from app.core.messaging.connection import RabbitMQConnection
from app.core.providers.env_config import get_env_config

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Worker lifespan: open the broker connection and (in later phases) start
    consuming order outcome events to send emails. This service owns no
    database — it only reacts to events and talks to SMTP (Mailhog).
    """
    config = get_env_config()
    broker = RabbitMQConnection(config.rabbitmq_url)
    try:
        await broker.connect()
        logger.info("notification-service connected to broker")
        # Phase 4: declare topology and start the order-events consumer here.
    except Exception as exc:  # noqa: BLE001 - startup must stay resilient
        logger.warning("notification-service could not connect to broker: %s", exc)
    app.state.broker = broker
    yield
    await broker.close()


app = FastAPI(title="notification-service", version="0.1.0", lifespan=lifespan)
register_exception_handlers(app)


@app.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    """Health check: broker connectivity only (this service has no database).
    Always returns 200."""
    broker = getattr(app.state, "broker", None)
    broker_status = "healthy" if broker is not None and broker.is_connected else "unhealthy"

    return {
        "status": "ok",
        "service": "notification-service",
        "broker": broker_status,
    }
