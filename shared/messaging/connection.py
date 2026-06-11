"""Broker connection wrapper + cold-start retry helper.

``RabbitMQConnection`` is a thin wrapper around an aio-pika robust connection
+ channel, shared by every service. ``connect_with_retry`` wraps its
``connect()`` (or any zero-arg async callable) with exponential backoff so a
service survives a cold start where RabbitMQ is not ready yet.

Once the first connection succeeds, ``aio_pika.connect_robust`` takes over:
it reconnects automatically (and re-declares topology/consumers registered
on its robust channel) if the broker drops later. This helper only covers
the *initial* connection, which ``connect_robust`` does not retry on its own
(``fail_fast`` defaults to ``True``).
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable

import aio_pika
from aio_pika.exceptions import CONNECTION_EXCEPTIONS

logger = logging.getLogger(__name__)


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


async def connect_with_retry(
    connect: Callable[[], Awaitable[None]],
    *,
    service_name: str,
    max_attempts: int | None = 5,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> bool:
    """Call ``connect`` until it succeeds, retrying with exponential backoff.

    Backoff doubles every attempt starting at ``base_delay`` seconds, capped
    at ``max_delay``. Only ``aio_pika.exceptions.CONNECTION_EXCEPTIONS`` (the
    same set ``connect_robust`` treats as transient) are retried — anything
    else propagates immediately.

    Returns ``True`` once ``connect`` succeeds. If ``max_attempts`` is
    exhausted first, returns ``False`` so the caller can decide what
    "still disconnected" means (degraded mode, background retry, ...).
    ``max_attempts=None`` retries forever and therefore always returns
    ``True``.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            await connect()
        except CONNECTION_EXCEPTIONS as exc:
            if max_attempts is not None and attempt >= max_attempts:
                logger.error(
                    "%s: giving up connecting to broker after %d attempt(s): %s",
                    service_name,
                    attempt,
                    exc,
                )
                return False

            delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
            logger.warning(
                "%s: broker connection attempt %d failed (%s); retrying in %.1fs",
                service_name,
                attempt,
                exc,
                delay,
            )
            await sleep(delay)
        else:
            if attempt > 1:
                logger.info(
                    "%s: connected to broker after %d attempt(s)", service_name, attempt
                )
            return True
