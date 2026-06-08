import aio_pika


class RabbitMQConnection:
    """Thin wrapper around an aio-pika robust connection + channel.

    Infrastructure detail only. Use cases never see this class — they depend
    on ports. Consumers and the publisher borrow this connection's channel.
    """

    def __init__(self, url: str) -> None:
        self._url = url
        self._connection: aio_pika.abc.AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractRobustChannel | None = None

    async def connect(self) -> None:
        """Open a robust connection and a channel. Idempotent."""
        if self._connection is not None and not self._connection.is_closed:
            return
        self._connection = await aio_pika.connect_robust(self._url, timeout=5)
        self._channel = await self._connection.channel()

    async def close(self) -> None:
        """Close the connection if open."""
        if self._connection is not None and not self._connection.is_closed:
            await self._connection.close()

    @property
    def is_connected(self) -> bool:
        return self._connection is not None and not self._connection.is_closed

    @property
    def channel(self) -> aio_pika.abc.AbstractRobustChannel:
        if self._channel is None:
            raise RuntimeError("Broker channel not initialized — call connect() first")
        return self._channel
