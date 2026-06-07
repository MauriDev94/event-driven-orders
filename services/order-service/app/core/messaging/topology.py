import aio_pika

# --- Exchange / queue names (single source of truth for the orders flow) ---
ORDERS_EXCHANGE = "orders"
ORDERS_DLX = "orders.dlx"

# order-service consumes inventory results on this queue.
ORDER_RESULTS_QUEUE = "order-service.inventory-results"
ORDER_RESULTS_DLQ = "order-service.inventory-results.dlq"

# Routing keys (event_type values, see shared.contracts).
ROUTING_STOCK_RESERVED = "stock.reserved"
ROUTING_STOCK_REJECTED = "stock.rejected"


async def declare_topology(channel: aio_pika.abc.AbstractRobustChannel) -> None:
    """Declare the orders topic exchange, the dead-letter exchange and the
    queues this service consumes from.

    SCAFFOLD: structure is defined here but binding/consumer wiring is
    completed in later phases. Declaring is idempotent on RabbitMQ, so this
    is safe to call on every startup.
    """
    await channel.declare_exchange(ORDERS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True)
    await channel.declare_exchange(ORDERS_DLX, aio_pika.ExchangeType.TOPIC, durable=True)
    # Dead-letter queue first so the main queue can reference it.
    await channel.declare_queue(ORDER_RESULTS_DLQ, durable=True)
    await channel.declare_queue(
        ORDER_RESULTS_QUEUE,
        durable=True,
        arguments={
            "x-dead-letter-exchange": ORDERS_DLX,
            "x-dead-letter-routing-key": ORDER_RESULTS_DLQ,
        },
    )
