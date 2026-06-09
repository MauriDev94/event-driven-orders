"""Shared test fixtures for the inventory-service test suite.

Integration tests run against a *real* PostgreSQL instance — SQLite lacks
row-level locking and ``SELECT ... FOR UPDATE``, which are the backbone of the
race-condition guarantee. Two execution environments are supported:

* **CI** (GitHub Actions ``tests-db`` job): a Postgres service container is
  already running; its coordinates are passed as env vars (``db_host``,
  ``db_port``, ``db_user``, ``db_password``, ``db_name``) that ``EnvConfig``
  picks up via pydantic-settings. The conftest detects CI by checking for the
  ``CI`` env var (always set by GitHub Actions) or an explicit
  ``TEST_DB_URL`` override.

* **Local dev**: no Postgres assumed. The fixture spins up a
  ``postgres:16-alpine`` container via testcontainers-python, waits until it
  is ready, creates the schema, and tears it down after the test session.

Unit tests (pure use-case tests with fake repos) do **not** depend on the DB
fixtures and run independently in both environments.
"""

import os
from collections.abc import Callable, Generator

import pytest
from fastapi.testclient import TestClient
from shared.contracts.base_event import BaseEvent
from sqlalchemy import create_engine, insert, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core.data.source.local.sql_alchemy_base import SqlAlchemyBase
from app.features.inventory.application.contracts.event_publisher import EventPublisher
from app.features.inventory.application.contracts.unit_of_work import UnitOfWork
from app.features.inventory.infrastructure.models import (  # noqa: F401 - register tables
    processed_event_model,
    product_model,
)
from app.features.inventory.infrastructure.models.product_model import ProductModel
from app.features.inventory.infrastructure.persistence.sqlalchemy_unit_of_work import (
    SqlAlchemyUnitOfWork,
)
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
        user = os.getenv("db_user", "inventory")
        password = os.getenv("db_password", "inventory")
        name = os.getenv("db_name", "inventory")
        return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{name}"

    return None


# ---------------------------------------------------------------------------
# Session-scoped DB engine (shared across all tests for performance)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def db_url() -> Generator[str, None, None]:
    """Resolve the Postgres connection URL for the test session.

    CI: read from env. Local: spin up a testcontainers Postgres, yield the URL,
    then stop the container.
    """
    url = _build_db_url_from_env()
    if url:
        yield url
        return

    # Local dev: launch an ephemeral Postgres via testcontainers.
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

    NullPool prevents connection reuse across test workers (safe for both
    testcontainers and real-container CI).
    """
    engine = create_engine(db_url, poolclass=NullPool)
    SqlAlchemyBase.metadata.create_all(engine)
    yield engine
    SqlAlchemyBase.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture
def session_factory(pg_engine) -> sessionmaker:
    """Function-scoped session factory pointing at the test Postgres."""
    return sessionmaker(bind=pg_engine, autocommit=False, autoflush=False)


@pytest.fixture(autouse=True)
def clean_tables(pg_engine) -> Generator[None, None, None]:
    """Truncate all mutable tables between tests to guarantee isolation.

    TRUNCATE ... RESTART IDENTITY CASCADE resets both rows and sequences so
    each test starts with a clean slate without rebuilding the schema.
    """
    yield
    with pg_engine.begin() as conn:
        conn.execute(text("TRUNCATE TABLE products, processed_events RESTART IDENTITY CASCADE"))


# ---------------------------------------------------------------------------
# UnitOfWork + publisher
# ---------------------------------------------------------------------------


@pytest.fixture
def uow_factory(session_factory) -> Callable[[], UnitOfWork]:
    return lambda: SqlAlchemyUnitOfWork(session_factory)


@pytest.fixture
def seed_products(session_factory) -> Callable[[dict[str, int]], None]:
    """Return a helper that seeds ``sku -> available_quantity`` rows."""

    def _seed(stock: dict[str, int]) -> None:
        session: Session = session_factory()
        try:
            for sku, quantity in stock.items():
                session.execute(
                    insert(ProductModel).values(id=sku, sku=sku, available_quantity=quantity)
                )
            session.commit()
        finally:
            session.close()

    return _seed


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
# FastAPI test client (health + lifespan tests, broker is resilient)
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client
