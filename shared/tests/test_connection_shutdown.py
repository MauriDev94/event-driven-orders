"""Regression tests: ``RabbitMQConnection.connect()`` must not block shutdown.

``aio_pika``'s ``RobustConnection`` makes its connection attempts in a
background task that swallows ``asyncio.CancelledError`` and keeps
reconnecting until the connection is closed. When ``connect()`` is cancelled
mid-attempt (a service shutting down while the broker is unreachable) and
nobody closes that half-open connection, ``asyncio.run()`` waits for the
task forever and the process never exits.

The "broker" here is a loopback TCP server that accepts the socket and never
answers the AMQP handshake, so the cancellation always lands mid-attempt.
No RabbitMQ or Docker needed.

The scenario runs under its own ``asyncio.run()`` in a daemon thread: the
symptom is that ``asyncio.run()`` never returns, and a thread is the only
way to observe that with a timeout instead of hanging the test session.
"""

import asyncio
import contextlib
import threading

from shared.messaging.connection import RabbitMQConnection

# The fixed shutdown takes well under a second; the margin avoids flakes on
# slow machines.
_SHUTDOWN_TIMEOUT_S = 10.0


async def _cancel_connect_mid_handshake() -> None:
    accepted = asyncio.Event()
    release = asyncio.Event()

    async def silent_broker(_reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        accepted.set()
        await release.wait()
        writer.close()

    server = await asyncio.start_server(silent_broker, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    broker = RabbitMQConnection(f"amqp://127.0.0.1:{port}/")

    connect = asyncio.create_task(broker.connect())
    await accepted.wait()
    connect.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await connect

    assert broker.is_connected is False

    release.set()
    server.close()


def test_should_not_block_event_loop_shutdown_when_connect_is_cancelled() -> None:
    errors: list[BaseException] = []

    def run_scenario() -> None:
        try:
            asyncio.run(_cancel_connect_mid_handshake())
        except BaseException as exc:
            errors.append(exc)

    thread = threading.Thread(target=run_scenario, daemon=True)
    thread.start()
    thread.join(timeout=_SHUTDOWN_TIMEOUT_S)

    assert not thread.is_alive(), (
        "asyncio.run() did not return: the cancelled connect() left aio_pika's "
        "reconnect task running"
    )
    assert errors == []
