"""Shared fixtures and helpers for forcing tests against a real RabbitMQ.

These tests spin up a real RabbitMQ broker via ``testcontainers[rabbitmq]``
and exercise the retry/DLQ topology end-to-end through ``wrap_with_retry``.
They complement — but do not replace — the AsyncMock-based tests in
``shared/tests/test_retry_dispatcher.py`` and the per-service
``test_*_retry_dlq.py`` files: those cover the dispatcher's logic in
isolation; these cover the actual AMQP behavior (TTL queues, dead-letter
routing, headers surviving a real round-trip through the broker).

Run from WSL with the venv that has Docker access (``.wsl-venv``):

    uv run --package shared pytest -m integration

Or skip the slow scenarios and run only the fast permanent-failure one:

    uv run --package shared pytest -m "integration and not slow"

Local-only by design for now: CI inclusion is a follow-up to issue #39.
"""

from __future__ import annotations

import asyncio

import aio_pika
import pytest
from testcontainers.core.waiting_utils import wait_container_is_ready
from testcontainers.rabbitmq import RabbitMqContainer

from shared.messaging.retry_policy import RETRY_STAGES

# Pinned to the management-enabled image so the RabbitMQ Management UI is
# available at 15672 during local debugging — same tag the docker-compose
# stack uses in this repo.
_RABBIT_IMAGE = "rabbitmq:3.13-management"


class _AioPikaReadyRabbitMqContainer(RabbitMqContainer):
    """``RabbitMqContainer`` whose readiness probe uses ``aio_pika``.

    The default ``RabbitMqContainer.readiness_probe`` opens a blocking
    ``pika.BlockingConnection`` against the broker. ``pika`` 1.4 has a
    protocol-handshake regression that surfaces during the broker's cold
    start (the server returns EOF before completing the AMQP 0.9.1
    negotiation), and the readiness probe times out after ``max_tries``
    even though the broker eventually accepts connections — ``aio_pika``
    connects cleanly against the same broker. This subclass replaces the
    default probe with an ``aio_pika`` connect attempt.
    """

    @wait_container_is_ready(aio_pika.exceptions.AMQPConnectionError)
    def readiness_probe(self) -> bool:
        """Connect with ``aio_pika`` instead of ``pika`` for readiness.

        The probe only needs to verify the broker accepts connections; the
        connection is left for garbage collection rather than awaited-closed
        (its ``close()`` is a coroutine and we have no running loop here).
        """
        connection = asyncio.run(
            aio_pika.connect(
                f"amqp://{self.username}:{self.password}"
                f"@{self.get_container_host_ip()}:{self.get_exposed_port(self.port)}/{self.vhost}"
            )
        )
        return self if connection else False


@pytest.fixture(scope="session")
def rabbitmq_container() -> RabbitMqContainer:
    """Session-scoped fixture: a real RabbitMQ broker for the forcing suite.

    Yields the underlying ``RabbitMqContainer`` (use ``get_connection_params()``
    to get a connection object). The container is torn down automatically
    when the session ends.

    Uses the ``_AioPikaReadyRabbitMqContainer`` subclass so the readiness
    probe succeeds under ``pika`` 1.4 + RabbitMQ 3.13 (see class docstring).
    """
    with _AioPikaReadyRabbitMqContainer(_RABBIT_IMAGE) as container:
        yield container


@pytest.fixture(scope="session")
def rabbitmq_url(rabbitmq_container: RabbitMqContainer) -> str:
    """AMQP URL pointing at the testcontainer broker (session-scoped).

    ``RabbitMqContainer`` exposes a ``pika.ConnectionParameters`` object but
    no built-in URL helper in this testcontainers version, so the URL is
    built here from the same fields the readiness probe uses.
    """
    host = rabbitmq_container.get_container_host_ip()
    port = rabbitmq_container.get_exposed_port(rabbitmq_container.port)
    user = rabbitmq_container.username
    password = rabbitmq_container.password
    vhost = rabbitmq_container.vhost
    # vhost "/" must be percent-encoded so the URL is parseable by aio_pika.
    from urllib.parse import quote

    return f"amqp://{user}:{password}@{host}:{port}/{quote(vhost, safe='')}"


async def declare_forcing_topology(channel, main_queue_name):
    """Declare the retry/DLQ topology for the forcing test.

    Mirrors the production shape (one main queue + 3 retry queues + 1 DLQ)
    using the same TTL schedule from ``RETRY_STAGES``. Returns the
    ``(main_queue, dlq)`` queue handles so the caller can publish to the
    main queue and spy on the DLQ.

    Kept as a shared test helper rather than promoted to production code:
    the real topology lives per-service in
    ``services/*/app/core/messaging/topology.py`` and depends on per-service
    routing keys. The forcing test only needs the structural shape; the
    bindings to the topic exchange are irrelevant for end-to-end retry/DLQ.
    """
    dlq_name = f"{main_queue_name}.dlq"

    dlq = await channel.declare_queue(dlq_name, durable=True)
    main_queue = await channel.declare_queue(
        main_queue_name,
        durable=True,
        arguments={
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": dlq_name,
        },
    )
    for suffix, ttl_ms in RETRY_STAGES:
        await channel.declare_queue(
            f"{main_queue_name}.{suffix}",
            durable=True,
            arguments={
                "x-message-ttl": ttl_ms,
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": main_queue_name,
            },
        )
    return main_queue, dlq


# Re-exported so tests can do `from .conftest import rabbitmq_container`
# without surprise at fixture discovery rules.
__all__ = [
    "_AioPikaReadyRabbitMqContainer",
    "declare_forcing_topology",
    "rabbitmq_container",
    "rabbitmq_url",
]
