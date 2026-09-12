"""Unit tests for the shared broker-connection retry helper (pure logic).

``connect_with_retry`` wraps a connect callable with exponential backoff so a
service can survive a cold start where RabbitMQ is not ready yet. The actual
``aio_pika.connect_robust`` call is mocked — these tests only cover the retry
loop: classification, backoff schedule, and give-up behavior.

``RabbitMQConnection.is_connected`` is also covered here. ``/health`` of every
service reads it to decide whether to report ``"broker": "healthy"``. The
property must reflect the actual reachability of the broker — including
``aio_pika``'s reconnect loop, where ``is_closed`` stays ``False`` while the
underlying socket is unreachable.
"""

import asyncio

import aio_pika.exceptions
import pytest

from shared.messaging.connection import RabbitMQConnection, connect_with_retry

pytestmark = pytest.mark.unit


class _FakeSleep:
    """Records every delay it was asked to sleep for, without waiting."""

    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, delay: float) -> None:
        self.delays.append(delay)


def _failing_then_succeeding(failures: int) -> tuple[list[int], object]:
    """Return (call_counter, connect_fn) where ``connect_fn`` raises a
    transient connection error ``failures`` times, then succeeds."""
    calls = {"count": 0}

    async def connect() -> None:
        calls["count"] += 1
        if calls["count"] <= failures:
            raise ConnectionError("connection refused")

    return calls, connect


async def test_should_succeed_on_first_attempt_without_sleeping() -> None:
    sleep = _FakeSleep()
    calls, connect = _failing_then_succeeding(failures=0)

    connected = await connect_with_retry(connect, service_name="svc", sleep=sleep)

    assert connected is True
    assert calls["count"] == 1
    assert sleep.delays == []


async def test_should_retry_with_exponential_backoff_until_success() -> None:
    sleep = _FakeSleep()
    calls, connect = _failing_then_succeeding(failures=2)

    connected = await connect_with_retry(
        connect, service_name="svc", max_attempts=5, base_delay=1.0, sleep=sleep
    )

    assert connected is True
    assert calls["count"] == 3
    assert sleep.delays == [1.0, 2.0]


async def test_should_give_up_after_max_attempts_and_return_false() -> None:
    sleep = _FakeSleep()
    calls, connect = _failing_then_succeeding(failures=10)

    connected = await connect_with_retry(
        connect, service_name="svc", max_attempts=3, base_delay=1.0, sleep=sleep
    )

    assert connected is False
    assert calls["count"] == 3
    assert sleep.delays == [1.0, 2.0]


async def test_should_retry_indefinitely_when_max_attempts_is_none() -> None:
    sleep = _FakeSleep()
    calls, connect = _failing_then_succeeding(failures=5)

    connected = await connect_with_retry(
        connect, service_name="svc", max_attempts=None, base_delay=1.0, sleep=sleep
    )

    assert connected is True
    assert calls["count"] == 6
    assert sleep.delays == [1.0, 2.0, 4.0, 8.0, 16.0]


async def test_should_cap_backoff_at_max_delay() -> None:
    sleep = _FakeSleep()
    calls, connect = _failing_then_succeeding(failures=5)

    connected = await connect_with_retry(
        connect,
        service_name="svc",
        max_attempts=None,
        base_delay=1.0,
        max_delay=5.0,
        sleep=sleep,
    )

    assert connected is True
    assert sleep.delays == [1.0, 2.0, 4.0, 5.0, 5.0]


async def test_should_propagate_non_connection_errors_without_retrying() -> None:
    sleep = _FakeSleep()

    async def connect() -> None:
        raise ValueError("not a connection problem")

    with pytest.raises(ValueError, match="not a connection problem"):
        await connect_with_retry(connect, service_name="svc", sleep=sleep)

    assert sleep.delays == []


async def test_should_treat_amqp_connection_error_as_transient() -> None:
    sleep = _FakeSleep()
    calls = {"count": 0}

    async def connect() -> None:
        calls["count"] += 1
        if calls["count"] == 1:
            raise aio_pika.exceptions.AMQPConnectionError("refused")

    connected = await connect_with_retry(connect, service_name="svc", sleep=sleep)

    assert connected is True
    assert calls["count"] == 2
    assert sleep.delays == [1.0]


async def test_default_sleep_is_asyncio_sleep() -> None:
    import inspect

    sig = inspect.signature(connect_with_retry)
    assert sig.parameters["sleep"].default is asyncio.sleep


class _FakeEvent:
    """Minimal stand-in for ``asyncio.Event`` exposing only ``is_set()``."""

    def __init__(self, set_: bool) -> None:
        self._set = set_

    def is_set(self) -> bool:
        return self._set


class _FakeConnection:
    """Stand-in for ``aio_pika.RobustConnection`` exposing only the attributes
    ``RabbitMQConnection.is_connected`` reads."""

    def __init__(self, *, is_closed: bool, connected: bool) -> None:
        self.is_closed = is_closed
        self.connected = _FakeEvent(set_=connected)


class TestRabbitMQConnectionIsConnected:
    """Coverage for ``RabbitMQConnection.is_connected``.

    Every service's ``/health`` reads this property. If it reports ``True``
    while the broker is actually unreachable, ``/health`` lies — which is
    exactly what happened when the implementation only checked
    ``connection.is_closed`` (which ``aio_pika`` keeps ``False`` during its
    internal reconnect loop).
    """

    def test_returns_false_when_connection_was_never_established(self) -> None:
        broker = RabbitMQConnection("amqp://localhost")
        assert broker.is_connected is False

    def test_returns_false_when_connection_is_closed(self) -> None:
        broker = RabbitMQConnection("amqp://localhost")
        broker._connection = _FakeConnection(is_closed=True, connected=False)
        assert broker.is_connected is False

    def test_returns_false_during_reconnect_loop_when_broker_unreachable(self) -> None:
        """When ``aio_pika``'s ``RobustConnection`` is in its reconnect loop
        (broker down), ``is_closed`` stays ``False`` but the ``connected``
        event is cleared. ``is_connected`` must reflect the unreachable
        state so ``/health`` does not lie during a broker outage.
        """
        broker = RabbitMQConnection("amqp://localhost")
        broker._connection = _FakeConnection(is_closed=False, connected=False)
        assert broker.is_connected is False

    def test_returns_true_when_connection_event_is_set(self) -> None:
        broker = RabbitMQConnection("amqp://localhost")
        broker._connection = _FakeConnection(is_closed=False, connected=True)
        assert broker.is_connected is True
