from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.main import app

pytestmark = pytest.mark.integration


class _FakeBroker:
    """Stand-in broker that always connects, exposing a sentinel channel."""

    def __init__(self, url: str) -> None:
        self.url = url

    async def connect(self) -> None:
        return None

    async def close(self) -> None:
        return None

    @property
    def is_connected(self) -> bool:
        return True

    @property
    def channel(self) -> str:
        return "fake-channel"


def test_should_declare_topology_on_startup_when_broker_connects(monkeypatch) -> None:
    declare_spy = AsyncMock()
    monkeypatch.setattr(main_module, "RabbitMQConnection", _FakeBroker)
    monkeypatch.setattr(main_module, "declare_topology", declare_spy)

    with TestClient(app):
        pass

    declare_spy.assert_awaited_once_with("fake-channel")


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


@pytest.mark.usefixtures("db_session_override")
def test_should_spawn_watchdog_and_recover_when_broker_unreachable_at_startup(
    monkeypatch,
) -> None:
    """Cold start: the broker is down. The bounded retry in the lifespan
    gives up, but a background watchdog keeps retrying and finishes startup
    once the broker becomes reachable — no manual restart needed."""
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


def test_should_dispose_the_engine_pool_on_shutdown(monkeypatch) -> None:
    database = Mock()
    monkeypatch.setattr(main_module, "RabbitMQConnection", _FakeBroker)
    monkeypatch.setattr(main_module, "declare_topology", AsyncMock())
    monkeypatch.setattr(main_module, "get_database", lambda: database)

    with TestClient(app):
        database.engine.dispose.assert_not_called()

    database.engine.dispose.assert_called_once_with()
