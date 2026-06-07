import aio_pika

# --- Exchange / queue names for the notification side of the orders flow ---
ORDERS_EXCHANGE = "orders"
ORDERS_DLX = "orders.dlx"

# notification-service consumes order outcomes on this queue.
ORDER_OUTCOMES_QUEUE = "notification-service.order-outcomes"
ORDER_OUTCOMES_DLQ = "notification-service.order-outcomes.dlq"

# Routing keys (event_type values, see shared.contracts).
ROUTING_ORDER_CONFIRMED = "order.confirmed"
ROUTING_ORDER_REJECTED = "order.rejected"


async def declare_topology(channel: aio_pika.abc.AbstractRobustChannel) -> None:
    """Declare the orders topic exchange, the dead-letter exchange and the
    queue this service consumes from (bound to both order outcome events).

    SCAFFOLD: queue binding and consumer start happen in Phase 4.
    """
    exchange = await channel.declare_exchange(
        ORDERS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True
    )
    await channel.declare_exchange(ORDERS_DLX, aio_pika.ExchangeType.TOPIC, durable=True)
    await channel.declare_queue(ORDER_OUTCOMES_DLQ, durable=True)
    queue = await channel.declare_queue(
        ORDER_OUTCOMES_QUEUE,
        durable=True,
        arguments={
            "x-dead-letter-exchange": ORDERS_DLX,
            "x-dead-letter-routing-key": ORDER_OUTCOMES_DLQ,
        },
    )
    await queue.bind(exchange, routing_key=ROUTING_ORDER_CONFIRMED)
    await queue.bind(exchange, routing_key=ROUTING_ORDER_REJECTED)
