import aio_pika
from shared.contracts.base_event import BaseEvent
from shared.messaging.connection import RabbitMQConnection

from app.core.messaging.topology import ORDERS_EXCHANGE
from app.features.orders.application.contracts.event_publisher import EventPublisher


class AioPikaEventPublisher(EventPublisher):
    """aio-pika implementation of the EventPublisher port.

    Serializes the event to JSON and publishes it to the ``orders`` topic
    exchange under the given routing key. Messages are persistent so they
    survive a broker restart.
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
