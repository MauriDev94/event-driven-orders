from abc import ABC, abstractmethod

from shared.contracts.base_event import BaseEvent


class EventPublisher(ABC):
    """Outbound messaging port.

    Use cases depend on THIS, never on aio-pika. The aio-pika implementation
    lives in ``infrastructure/messaging/``.
    """

    @abstractmethod
    async def publish(self, event: BaseEvent, routing_key: str) -> None:
        """Publish an integration event to the broker under a routing key."""
        ...
