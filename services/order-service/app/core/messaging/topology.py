import aio_pika

# --- Exchange / queue names (single source of truth for the orders flow) ---
ORDERS_EXCHANGE = "orders"
ORDERS_DLX = "orders.dlx"

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
    """Declare the orders topic exchange, the dead-letter exchange and the
    queues this service consumes from, with bindings for inventory results.

    Binds ``order-service.inventory-results`` to ``stock.reserved`` and
    ``stock.rejected`` so the order-service receives the outcome of each
    stock-reservation attempt. Declaration is idempotent on RabbitMQ.
    """
    exchange = await channel.declare_exchange(
        ORDERS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True
    )
    await channel.declare_exchange(ORDERS_DLX, aio_pika.ExchangeType.TOPIC, durable=True)
    # Dead-letter queue first so the main queue can reference it.
    await channel.declare_queue(ORDER_RESULTS_DLQ, durable=True)
    queue = await channel.declare_queue(
        ORDER_RESULTS_QUEUE,
        durable=True,
        arguments={
            "x-dead-letter-exchange": ORDERS_DLX,
            "x-dead-letter-routing-key": ORDER_RESULTS_DLQ,
        },
    )
    await queue.bind(exchange, routing_key=ROUTING_STOCK_RESERVED)
    await queue.bind(exchange, routing_key=ROUTING_STOCK_REJECTED)
