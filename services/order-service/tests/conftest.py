import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> TestClient:
    """FastAPI test client that runs the app lifespan (broker connect is
    resilient, so this works without infrastructure)."""
    with TestClient(app) as test_client:
        yield test_client
