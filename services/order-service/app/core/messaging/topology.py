import aio_pika
from shared.messaging.retry_policy import RETRY_STAGES

# --- Exchange / queue names (single source of truth for the orders flow) ---
ORDERS_EXCHANGE = "orders"

# order-service consumes inventory results on this queue.
ORDER_RESULTS_QUEUE = "order-service.inventory-results"
ORDER_RESULTS_DLQ = "order-service.inventory-results.dlq"

# Routing keys (event_type values, see shared.contracts).
ROUTING_ORDER_CREATED = "order.created"
ROUTING_ORDER_CONFIRMED = "order.confirmed"
ROUTING_ORDER_REJECTED = "order.rejected"
ROUTING_STOCK_RESERVED = "stock.reserved"
ROUTING_STOCK_REJECTED = "stock.rejected"


async def declare_topology(channel: aio_pika.abc.AbstractRobustChannel) -> None:
    """Declare the orders topic exchange and the queues this service
    consumes from, with bindings for inventory results, plus the
    retry/DLQ infrastructure for resilient processing.

    Binds ``order-service.inventory-results`` to ``stock.reserved`` and
    ``stock.rejected`` so the order-service receives the outcome of each
    stock-reservation attempt. Declaration is idempotent on RabbitMQ.

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
    await channel.declare_queue(ORDER_RESULTS_DLQ, durable=True)
    for suffix, ttl_ms in RETRY_STAGES:
        await channel.declare_queue(
            f"{ORDER_RESULTS_QUEUE}.{suffix}",
            durable=True,
            arguments={
                "x-message-ttl": ttl_ms,
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": ORDER_RESULTS_QUEUE,
            },
        )
    queue = await channel.declare_queue(
        ORDER_RESULTS_QUEUE,
        durable=True,
        arguments={
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": ORDER_RESULTS_DLQ,
        },
    )
    await queue.bind(exchange, routing_key=ROUTING_STOCK_RESERVED)
    await queue.bind(exchange, routing_key=ROUTING_STOCK_REJECTED)
