import pytest
from fastapi.testclient import TestClient
from shared.contracts.base_event import BaseEvent
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.data.source.local.sql_alchemy_base import SqlAlchemyBase
from app.core.providers.db import get_db_session
from app.features.orders.application.contracts.event_publisher import EventPublisher
from app.features.orders.di.dependencies import get_event_publisher
from app.features.orders.infrastructure.models import order_model  # noqa: F401 - register tables
from app.main import app


@pytest.fixture
def client() -> TestClient:
    """FastAPI test client that runs the app lifespan (broker connect is
    resilient, so this works without infrastructure)."""
    with TestClient(app) as test_client:
        yield test_client


class SpyEventPublisher(EventPublisher):
    """Records publish calls instead of touching a real broker."""

    def __init__(self) -> None:
        self.calls: list[tuple[BaseEvent, str]] = []

    async def publish(self, event: BaseEvent, routing_key: str) -> None:
        self.calls.append((event, routing_key))


@pytest.fixture
def db_session_factory():
    """Throwaway in-memory SQLite DB with the schema created from metadata.

    StaticPool keeps a single connection so the in-memory DB is shared across
    the request session and the test's own queries. No Postgres needed.
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SqlAlchemyBase.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    yield session_factory
    SqlAlchemyBase.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture
def spy_publisher() -> SpyEventPublisher:
    return SpyEventPublisher()


@pytest.fixture
def api_client(db_session_factory, spy_publisher):
    """Test client with the DB and broker boundaries replaced by fakes.

    The orders feature talks to SQLite (real persistence behavior) and a spy
    publisher (event capture) — exercising the full HTTP -> use case -> repo
    path without any external infrastructure.
    """

    def override_get_db():
        session = db_session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db_session] = override_get_db
    app.dependency_overrides[get_event_publisher] = lambda: spy_publisher
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
