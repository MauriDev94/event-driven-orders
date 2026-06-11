"""Cold-start broker reconnection: when RabbitMQ is unreachable at startup,
the bounded retry gives up but a background watchdog keeps retrying and
finishes startup once the broker becomes reachable — no manual restart
needed. See ``shared/tests/test_connection.py`` for the retry/backoff logic
itself.
"""

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.main import app

pytestmark = pytest.mark.integration


class _FakeBrokerThatNeverConnects:
    """Stand-in broker whose ``connect()`` always fails (broker unreachable
    at cold start)."""

    def __init__(self, url: str) -> None:
        self.url = url

    async def connect(self) -> None:
        raise ConnectionError("connection refused")

    async def close(self) -> None:
        return None

    @property
    def is_connected(self) -> bool:
        return False

    @property
    def channel(self) -> str:
        return "fake-channel"


async def _await(task) -> None:
    await task


def test_should_spawn_watchdog_and_recover_when_broker_unreachable_at_startup(
    monkeypatch,
) -> None:
    declare_spy = AsyncMock()
    connect_with_retry_mock = AsyncMock(side_effect=[False, True])
    monkeypatch.setattr(main_module, "RabbitMQConnection", _FakeBrokerThatNeverConnects)
    monkeypatch.setattr(main_module, "connect_with_retry", connect_with_retry_mock)
    monkeypatch.setattr(main_module, "declare_topology", declare_spy)

    with TestClient(app) as client:
        watchdog = app.state.broker_watchdog
        assert watchdog is not None

        client.portal.call(_await, watchdog)

        response = client.get("/health")

    assert connect_with_retry_mock.await_count == 2
    declare_spy.assert_awaited_once_with("fake-channel")
    assert response.json()["broker"] == "unhealthy"
