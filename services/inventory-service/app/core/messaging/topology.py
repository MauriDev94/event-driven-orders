import aio_pika
from shared.messaging.retry_policy import RETRY_STAGES

# --- Exchange / queue names for the inventory side of the orders flow ---
ORDERS_EXCHANGE = "orders"

# inventory-service consumes OrderCreated on this queue.
ORDER_CREATED_QUEUE = "inventory-service.order-created"
ORDER_CREATED_DLQ = "inventory-service.order-created.dlq"

# Routing keys (event_type values, see shared.contracts).
ROUTING_ORDER_CREATED = "order.created"
ROUTING_STOCK_RESERVED = "stock.reserved"
ROUTING_STOCK_REJECTED = "stock.rejected"


async def declare_topology(channel: aio_pika.abc.AbstractRobustChannel) -> None:
    """Declare the orders topic exchange and the queue this service consumes
    from (bound to ``order.created``), plus the retry/DLQ infrastructure for
    resilient processing.

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
    await channel.declare_queue(ORDER_CREATED_DLQ, durable=True)
    for suffix, ttl_ms in RETRY_STAGES:
        await channel.declare_queue(
            f"{ORDER_CREATED_QUEUE}.{suffix}",
            durable=True,
            arguments={
                "x-message-ttl": ttl_ms,
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": ORDER_CREATED_QUEUE,
            },
        )
    queue = await channel.declare_queue(
        ORDER_CREATED_QUEUE,
        durable=True,
        arguments={
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": ORDER_CREATED_DLQ,
        },
    )
    await queue.bind(exchange, routing_key=ROUTING_ORDER_CREATED)
