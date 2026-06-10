import aio_pika
from shared.messaging.retry_policy import RETRY_STAGES

# --- Exchange / queue names for the notification side of the orders flow ---
ORDERS_EXCHANGE = "orders"

# notification-service consumes order outcomes on this queue.
ORDER_OUTCOMES_QUEUE = "notification-service.order-outcomes"
ORDER_OUTCOMES_DLQ = "notification-service.order-outcomes.dlq"

# Routing keys (event_type values, see shared.contracts).
ROUTING_ORDER_CONFIRMED = "order.confirmed"
ROUTING_ORDER_REJECTED = "order.rejected"


async def declare_topology(channel: aio_pika.abc.AbstractRobustChannel) -> None:
    """Declare the orders topic exchange and the queue this service consumes
    from (bound to both order outcome events), plus the retry/DLQ
    infrastructure for resilient processing.

    Resilience (Phase 5): the main queue dead-letters straight to its DLQ
    via the *default* exchange (routing by queue name needs no binding —
    the previous ``orders.dlx`` topic exchange had no binding to the DLQ,
    so dead-lettered messages were silently dropped). One retry queue per
    backoff stage (``RETRY_STAGES``) is also declared, each with a TTL and
    a dead-letter back to the main queue via the default exchange — the
    retry dispatcher republishes failed messages there.
    """
    exchange = await channel.declare_exchange(
        ORDERS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True
    )
    await channel.declare_queue(ORDER_OUTCOMES_DLQ, durable=True)
    for suffix, ttl_ms in RETRY_STAGES:
        await channel.declare_queue(
            f"{ORDER_OUTCOMES_QUEUE}.{suffix}",
            durable=True,
            arguments={
                "x-message-ttl": ttl_ms,
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": ORDER_OUTCOMES_QUEUE,
            },
        )
    queue = await channel.declare_queue(
        ORDER_OUTCOMES_QUEUE,
        durable=True,
        arguments={
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": ORDER_OUTCOMES_DLQ,
        },
    )
    await queue.bind(exchange, routing_key=ROUTING_ORDER_CONFIRMED)
    await queue.bind(exchange, routing_key=ROUTING_ORDER_REJECTED)
