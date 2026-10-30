"""Fixtures for the end-to-end suite.

These tests run against the REAL stack started by `make up` (RabbitMQ + 2x
Postgres + Mailhog + the 3 services) — no mocks, no dependency overrides. The
only "test doubles" are Mailhog (a real SMTP server with an inspection API)
and the public HTTP APIs each service already exposes.

Base URLs are overridable via env vars (``E2E_*_URL``) so the suite can also
point at a stack running on different ports/hosts (e.g. CI, if ever enabled —
see README).
"""

import os
import time
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest

ORDER_SERVICE_URL = os.getenv("E2E_ORDER_SERVICE_URL", "http://localhost:8001")
INVENTORY_SERVICE_URL = os.getenv("E2E_INVENTORY_SERVICE_URL", "http://localhost:8002")
NOTIFICATION_SERVICE_URL = os.getenv("E2E_NOTIFICATION_SERVICE_URL", "http://localhost:8003")
MAILHOG_URL = os.getenv("E2E_MAILHOG_URL", "http://localhost:8025")

DEFAULT_TIMEOUT = float(os.getenv("E2E_TIMEOUT", "30"))
POLL_INTERVAL = 1.0

SERVICE_URLS = {
    "order-service": ORDER_SERVICE_URL,
    "inventory-service": INVENTORY_SERVICE_URL,
    "notification-service": NOTIFICATION_SERVICE_URL,
}


@pytest.fixture(scope="session")
def order_client() -> Any:
    with httpx.Client(base_url=ORDER_SERVICE_URL, timeout=10.0) as client:
        yield client


@pytest.fixture(scope="session")
def mailhog_client() -> Any:
    with httpx.Client(base_url=MAILHOG_URL, timeout=10.0) as client:
        yield client


def _not_ready(client: httpx.Client, mailhog_client: httpx.Client) -> dict[str, str]:
    """Return what is still missing, keyed by component (empty when ready)."""
    missing: dict[str, str] = {}
    for name, url in SERVICE_URLS.items():
        try:
            body = client.get(f"{url}/health").raise_for_status().json()
        except httpx.HTTPError as exc:
            missing[name] = repr(exc)
            continue
        # notification-service has no database, so its body has no such key.
        degraded = [dep for dep in ("database", "broker") if body.get(dep, "healthy") != "healthy"]
        if degraded:
            missing[name] = f"{' and '.join(degraded)} unhealthy"
    try:
        mailhog_client.get("/api/v2/messages").raise_for_status()
    except httpx.HTTPError as exc:
        missing["mailhog"] = repr(exc)
    return missing


@pytest.fixture(scope="session", autouse=True)
def _wait_for_stack(mailhog_client: httpx.Client) -> None:
    """Block until the 3 services report database and broker healthy, and
    Mailhog responds.

    A 200 from ``/health`` is not enough: it answers 200 with the broker down
    (ADR-0014). Right after ``make up`` a consumer may still be connecting,
    so its queue doesn't exist yet and the topic exchange drops any event
    published to it: the first order would never get its email. Each
    consumer declares its queues right after connecting, so once all 3
    report a healthy broker the flow is wired, give or take the milliseconds
    that declaration takes.
    """
    deadline = time.monotonic() + DEFAULT_TIMEOUT * 2
    missing: dict[str, str] = {}
    with httpx.Client(timeout=5.0) as client:
        while time.monotonic() < deadline:
            missing = _not_ready(client, mailhog_client)
            if not missing:
                return
            time.sleep(POLL_INTERVAL)
    pytest.fail(f"stack not ready after {DEFAULT_TIMEOUT * 2}s — run `make up` first: {missing}")


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
