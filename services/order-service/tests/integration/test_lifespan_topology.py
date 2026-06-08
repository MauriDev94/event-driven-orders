from unittest.mock import AsyncMock

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
