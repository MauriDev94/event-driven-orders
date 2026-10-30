from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.providers.db import get_db_session
from app.main import app

pytestmark = pytest.mark.integration


def test_should_return_200_when_health_is_requested(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200


def test_should_report_service_name_when_health_is_requested(client: TestClient) -> None:
    body = client.get("/health").json()

    assert body["service"] == "order-service"
    assert "database" in body
    assert "broker" in body


def test_should_report_database_healthy_when_the_test_database_is_reachable(
    client: TestClient,
) -> None:
    body = client.get("/health").json()

    assert body["database"] == "healthy"


def test_should_report_database_unhealthy_with_200_when_the_query_fails(
    client: TestClient,
) -> None:
    def broken_session():
        session = Mock(spec=Session)
        session.execute.side_effect = OperationalError("SELECT 1", None, Exception("refused"))
        yield session

    app.dependency_overrides[get_db_session] = broken_session

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["database"] == "unhealthy"
