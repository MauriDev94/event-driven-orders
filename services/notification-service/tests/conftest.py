import asyncio

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.main import app


async def _connect_with_retry_broker_down(connect, *, service_name, max_attempts=5, **_kwargs):
    """Stand-in for ``connect_with_retry`` with the broker down, without the
    real backoff or network: the lifespan's bounded retry gives up at once
    and the watchdog (``max_attempts=None``) waits until shutdown cancels it.
    It also keeps these tests off a broker that happens to be running
    locally (``make up``)."""
    if max_attempts is None:
        await asyncio.Event().wait()
    return False


@pytest.fixture
def client(monkeypatch) -> TestClient:
    """FastAPI test client that runs the worker lifespan with the broker down
    (the lifespan is resilient to that, so no infrastructure is needed)."""
    monkeypatch.setattr(main_module, "connect_with_retry", _connect_with_retry_broker_down)
    with TestClient(app) as test_client:
        yield test_client
