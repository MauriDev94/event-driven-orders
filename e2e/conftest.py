"""Fixtures for the end-to-end suite.

These tests run against the REAL stack started by `make up` (RabbitMQ + 2x
Postgres + Mailhog + the 3 services) — no mocks, no dependency overrides. The
only "test doubles" are Mailhog (a real SMTP server with an inspection API)
and the public HTTP APIs each service already exposes.

Base URLs are overridable via env vars so the suite can also point at a stack
running on different ports/hosts (e.g. CI, if ever enabled — see README).
"""

import os
import time
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest

ORDER_SERVICE_URL = os.getenv("E2E_ORDER_SERVICE_URL", "http://localhost:8001")
MAILHOG_URL = os.getenv("E2E_MAILHOG_URL", "http://localhost:8025")

DEFAULT_TIMEOUT = float(os.getenv("E2E_TIMEOUT", "30"))
POLL_INTERVAL = 1.0


@pytest.fixture(scope="session")
def order_client() -> Any:
    with httpx.Client(base_url=ORDER_SERVICE_URL, timeout=10.0) as client:
        yield client


@pytest.fixture(scope="session")
def mailhog_client() -> Any:
    with httpx.Client(base_url=MAILHOG_URL, timeout=10.0) as client:
        yield client


@pytest.fixture(scope="session", autouse=True)
def _wait_for_stack(order_client: httpx.Client, mailhog_client: httpx.Client) -> None:
    """Block until order-service and Mailhog respond.

    Without this, the first test to run while the stack is still starting
    fails with a connection error instead of a clear "not reachable" message.
    """
    deadline = time.monotonic() + DEFAULT_TIMEOUT * 2
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            order_client.get("/health").raise_for_status()
            mailhog_client.get("/api/v2/messages").raise_for_status()
            return
        except httpx.HTTPError as exc:
            last_error = exc
            time.sleep(POLL_INTERVAL)
    pytest.fail(
        f"stack not reachable at {ORDER_SERVICE_URL} / {MAILHOG_URL} "
        f"after {DEFAULT_TIMEOUT * 2}s — run `make up` first ({last_error!r})"
    )


@pytest.fixture
def wait_until() -> Callable[..., None]:
    """Return a polling helper: ``wait_until(predicate, message=...)``.

    Polls ``predicate()`` until it returns truthy or the timeout elapses.
    Avoids fixed `sleep`s for the async propagation across RabbitMQ.
    """

    def _wait(
        predicate: Callable[[], bool],
        timeout: float = DEFAULT_TIMEOUT,
        interval: float = POLL_INTERVAL,
        message: str = "condition not met",
    ) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(interval)
        pytest.fail(f"{message} (timed out after {timeout}s)")

    return _wait


@pytest.fixture
def unique_customer_id() -> str:
    """A fresh customer id per test, so Mailhog inboxes never collide."""
    return f"e2e-{uuid.uuid4().hex[:12]}"
