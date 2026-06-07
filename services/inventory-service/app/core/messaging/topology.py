import aio_pika

# --- Exchange / queue names for the inventory side of the orders flow ---
ORDERS_EXCHANGE = "orders"
ORDERS_DLX = "orders.dlx"

# inventory-service consumes OrderCreated on this queue.
ORDER_CREATED_QUEUE = "inventory-service.order-created"
ORDER_CREATED_DLQ = "inventory-service.order-created.dlq"

# Routing keys (event_type values, see shared.contracts).
ROUTING_ORDER_CREATED = "order.created"
ROUTING_STOCK_RESERVED = "stock.reserved"
ROUTING_STOCK_REJECTED = "stock.rejected"


async def declare_topology(channel: aio_pika.abc.AbstractRobustChannel) -> None:
    """Declare the orders topic exchange, the dead-letter exchange and the
    queue this service consumes from (bound to ``order.created``).

    SCAFFOLD: queue binding and consumer start happen in Phase 2.
    """
    exchange = await channel.declare_exchange(
        ORDERS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True
    )
    await channel.declare_exchange(ORDERS_DLX, aio_pika.ExchangeType.TOPIC, durable=True)
    await channel.declare_queue(ORDER_CREATED_DLQ, durable=True)
    queue = await channel.declare_queue(
        ORDER_CREATED_QUEUE,
        durable=True,
        arguments={
            "x-dead-letter-exchange": ORDERS_DLX,
            "x-dead-letter-routing-key": ORDER_CREATED_DLQ,
        },
    )
    await queue.bind(exchange, routing_key=ROUTING_ORDER_CREATED)
