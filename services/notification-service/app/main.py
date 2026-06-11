import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from shared.messaging.connection import RabbitMQConnection, connect_with_retry
from shared.messaging.retry_dispatcher import wrap_with_retry
from shared.observability.config import configure_logging

from app.core.exceptions.error_handling import register_exception_handlers
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

SERVICE_NAME = "notification-service"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Worker lifespan: open the broker connection, declare topology and start
    consuming order-outcome events (OrderConfirmed / OrderRejected) to send
    customer emails. This service owns no database — it only reacts to events
    and talks to SMTP (Mailhog).

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
        await _start_consuming(app, broker)
    else:
        app.state.broker_watchdog = asyncio.create_task(_reconnect_and_start(app, broker))

    yield

    if app.state.broker_watchdog is not None:
        app.state.broker_watchdog.cancel()
    await broker.close()


async def _reconnect_and_start(app: FastAPI, broker: RabbitMQConnection) -> None:
    """Background watchdog: keep retrying the initial connection forever
    (capped backoff) and finish startup once it succeeds."""
    await connect_with_retry(broker.connect, service_name=SERVICE_NAME, max_attempts=None)
    await _start_consuming(app, broker)


async def _start_consuming(app: FastAPI, broker: RabbitMQConnection) -> None:
    """Declare topology and start consuming order outcomes. Any failure here
    is logged and leaves the service in degraded mode rather than crashing
    the process."""
    try:
        await declare_topology(broker.channel)

        use_case = get_send_order_notification_use_case()
        deduplicator = InMemoryEventDeduplicator()
        handler = build_order_events_handler(use_case, deduplicator)

        resilient_handler = wrap_with_retry(
            handler, channel=broker.channel, main_queue_name=ORDER_OUTCOMES_QUEUE
        )
        queue = await broker.channel.get_queue(ORDER_OUTCOMES_QUEUE)
        await queue.consume(resilient_handler)
        logger.info("%s connected to broker and consuming order outcomes", SERVICE_NAME)
    except Exception as exc:  # noqa: BLE001 - startup must stay resilient
        logger.warning("%s could not start consuming from broker: %s", SERVICE_NAME, exc)


configure_logging(SERVICE_NAME)

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
