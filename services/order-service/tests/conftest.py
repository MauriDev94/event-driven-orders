"""Shared test fixtures for the order-service test suite.

Integration tests run against a *real* PostgreSQL instance — SQLite lacks
the ``INSERT … ON CONFLICT DO NOTHING`` (Postgres dialect) used by the
idempotency guard in ``SqlAlchemyOrderUnitOfWork``. Two environments:

* **CI** (GitHub Actions ``tests-db`` job): a Postgres service container is
  already running; its coordinates are passed as env vars (``db_host``,
  ``db_port``, ``db_user``, ``db_password``, ``db_name``) that ``EnvConfig``
  picks up via pydantic-settings. The conftest detects CI by checking for
  the ``CI`` env var (always set by GitHub Actions) or a ``TEST_DB_URL``
  override.

* **Local dev**: no Postgres assumed. The fixture spins up a
  ``postgres:16-alpine`` container via testcontainers-python, waits until it
  is ready, creates the schema, and tears it down after the test session.

Unit tests (pure use-case tests with fake repos) do **not** depend on the DB
fixtures and run independently in both environments.
"""

import os
from collections.abc import Callable, Generator
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from shared.contracts.base_event import BaseEvent
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core.data.source.local.sql_alchemy_base import SqlAlchemyBase
from app.core.providers.db import get_db_session
from app.features.orders.application.contracts.event_publisher import EventPublisher
from app.features.orders.application.contracts.unit_of_work import OrderUnitOfWork
from app.features.orders.infrastructure.models import (  # noqa: F401 - register tables
    order_model,  # noqa: F401 - register tables
    processed_event_model,
)
from app.features.orders.infrastructure.models.order_model import OrderLineModel, OrderModel
from app.features.orders.infrastructure.persistence.sqlalchemy_order_unit_of_work import (
    SqlAlchemyOrderUnitOfWork,
)
from app.features.orders.presentation.http.router import router as orders_router  # noqa: F401
from app.main import app

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_db_url_from_env() -> str | None:
    """Return a psycopg2 URL if the process env carries CI Postgres credentials.

    GitHub Actions sets ``CI=true`` and passes the individual ``db_*``
    variables. A ``TEST_DB_URL`` override is also respected for local ad-hoc
    runs against an existing Postgres.
    """
    explicit = os.getenv("TEST_DB_URL")
    if explicit:
        return explicit

    if os.getenv("CI"):
        host = os.getenv("db_host", "localhost")
        port = os.getenv("db_port", "5432")
        user = os.getenv("db_user", "orders")
        password = os.getenv("db_password", "orders")
        name = os.getenv("db_name", "orders")
        return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{name}"

    return None


# ---------------------------------------------------------------------------
# Session-scoped DB engine (shared across all tests for performance)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def db_url() -> Generator[str, None, None]:
    """Resolve the Postgres connection URL for the test session.

    CI: read from env. Local: spin up a testcontainers Postgres, yield the
    URL, then stop the container.
    """
    url = _build_db_url_from_env()
    if url:
        yield url
        return

    from testcontainers.postgres import PostgresContainer

    with PostgresContainer("postgres:16-alpine") as pg:
        yield (
            pg.get_connection_url()
            .replace("psycopg2", "psycopg2", 1)
            .replace("postgresql://", "postgresql+psycopg2://", 1)
        )


@pytest.fixture(scope="session")
def pg_engine(db_url: str):
    """Session-scoped SQLAlchemy engine pointing at the test Postgres.

    NullPool prevents connection reuse across test workers.
    """
    engine = create_engine(db_url, poolclass=NullPool)
    SqlAlchemyBase.metadata.create_all(engine)
    yield engine
    SqlAlchemyBase.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture
def session_factory(pg_engine) -> sessionmaker:  # type: ignore[type-arg]
    """Function-scoped session factory pointing at the test Postgres."""
    return sessionmaker(bind=pg_engine, autocommit=False, autoflush=False)


@pytest.fixture(autouse=True)
def clean_tables(pg_engine) -> Generator[None, None, None]:
    """Truncate all mutable tables between tests to guarantee isolation."""
    yield
    with pg_engine.begin() as conn:
        conn.execute(
            text("TRUNCATE TABLE orders, order_lines, processed_events RESTART IDENTITY CASCADE")
        )


# ---------------------------------------------------------------------------
# UnitOfWork
# ---------------------------------------------------------------------------


@pytest.fixture
def uow_factory(session_factory) -> Callable[[], OrderUnitOfWork]:
    return lambda: SqlAlchemyOrderUnitOfWork(session_factory)


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def seed_order(session_factory) -> Callable[[], OrderModel]:
    """Return a helper that inserts a pending order and its line into Postgres."""

    def _seed(
        order_id: str | None = None,
        customer_id: str = "customer-1",
    ) -> OrderModel:
        oid = order_id or str(uuid4())
        session: Session = session_factory()
        try:
            line = OrderLineModel(
                id=str(uuid4()),
                order_id=oid,
                product_id="p1",
                quantity=1,
                unit_price=Decimal("10.00"),
            )
            model = OrderModel(
                id=oid,
                customer_id=customer_id,
                status="pending",
                lines=[line],
            )
            session.add(model)
            session.commit()
            session.refresh(model)
            return model
        finally:
            session.close()

    return _seed


# ---------------------------------------------------------------------------
# Spy publisher
# ---------------------------------------------------------------------------


class SpyEventPublisher(EventPublisher):
    """Records publish calls instead of touching a real broker."""

    def __init__(self) -> None:
        self.calls: list[tuple[BaseEvent, str]] = []

    async def publish(self, event: BaseEvent, routing_key: str) -> None:
        self.calls.append((event, routing_key))


@pytest.fixture
def spy_publisher() -> SpyEventPublisher:
    return SpyEventPublisher()


# ---------------------------------------------------------------------------
# FastAPI test clients
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    """FastAPI test client that runs the app lifespan (broker connect is
    resilient, so this works without infrastructure)."""
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def api_client(session_factory, spy_publisher):
    """Test client with the DB and broker boundaries replaced by fakes.

    Uses real Postgres (session_factory) and a spy publisher — exercising
    the full HTTP → use case → repo path without a live broker.
    """
    from app.features.orders.di.dependencies import get_event_publisher

    def override_get_db():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db_session] = override_get_db
    app.dependency_overrides[get_event_publisher] = lambda: spy_publisher
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
