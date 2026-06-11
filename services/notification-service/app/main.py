import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from shared.messaging.retry_dispatcher import wrap_with_retry
from shared.observability.config import configure_logging

from app.core.exceptions.error_handling import register_exception_handlers
from app.core.messaging.connection import RabbitMQConnection
from app.core.messaging.topology import ORDER_OUTCOMES_QUEUE, declare_topology
from app.core.providers.env_config import get_env_config
from app.features.notifications.di.dependencies import get_send_order_notification_use_case
from app.features.notifications.infrastructure.dedup.in_memory_event_deduplicator import (
    InMemoryEventDeduplicator,
)
from app.features.notifications.presentation.consumers.order_events_consumer import (
    build_order_events_handler,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Worker lifespan: open the broker connection, declare topology and start
    consuming order-outcome events (OrderConfirmed / OrderRejected) to send
    customer emails. This service owns no database — it only reacts to events
    and talks to SMTP (Mailhog).

    A failed broker connection must NOT crash the app: ``/health`` reports the
    broker as unhealthy instead. Topology declaration is idempotent on
    RabbitMQ, so it is safe to run on every startup.
    """
    config = get_env_config()
    broker = RabbitMQConnection(config.rabbitmq_url)
    try:
        await broker.connect()
        await declare_topology(broker.channel)

        use_case = get_send_order_notification_use_case()
        deduplicator = InMemoryEventDeduplicator()
        handler = build_order_events_handler(use_case, deduplicator)

        resilient_handler = wrap_with_retry(
            handler, channel=broker.channel, main_queue_name=ORDER_OUTCOMES_QUEUE
        )
        queue = await broker.channel.get_queue(ORDER_OUTCOMES_QUEUE)
        await queue.consume(resilient_handler)
        logger.info("notification-service connected to broker and consuming order outcomes")
    except Exception as exc:  # noqa: BLE001 - startup must stay resilient
        logger.warning("notification-service could not connect to broker: %s", exc)
    app.state.broker = broker
    yield
    await broker.close()


configure_logging("notification-service")

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
