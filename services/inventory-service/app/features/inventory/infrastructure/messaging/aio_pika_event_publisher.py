import aio_pika
from shared.contracts.base_event import BaseEvent

from app.core.messaging.connection import RabbitMQConnection
from app.core.messaging.topology import ORDERS_EXCHANGE
from app.features.inventory.application.contracts.event_publisher import EventPublisher


class AioPikaEventPublisher(EventPublisher):
    """aio-pika implementation of the EventPublisher port.

    Publishes StockReserved/StockRejected to the ``orders`` topic exchange.
    """

    def __init__(self, connection: RabbitMQConnection) -> None:
        self._connection = connection

    async def publish(self, event: BaseEvent, routing_key: str) -> None:
        channel = self._connection.channel
        exchange = await channel.get_exchange(ORDERS_EXCHANGE)
        message = aio_pika.Message(
            body=event.model_dump_json().encode(),
            content_type="application/json",
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            message_id=event.event_id,
            correlation_id=event.correlation_id,
            type=event.event_type,
        )
        await exchange.publish(message, routing_key=routing_key)
