"""Unit tests for the shared broker-connection retry helper (pure logic).

``connect_with_retry`` wraps a connect callable with exponential backoff so a
service can survive a cold start where RabbitMQ is not ready yet. The actual
``aio_pika.connect_robust`` call is mocked — these tests only cover the retry
loop: classification, backoff schedule, and give-up behavior.
"""

import asyncio

import aio_pika.exceptions
import pytest

from shared.messaging.connection import connect_with_retry

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
