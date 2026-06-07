import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration


def test_should_return_200_when_health_is_requested(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200


def test_should_report_service_name_when_health_is_requested(client: TestClient) -> None:
    body = client.get("/health").json()

    assert body["service"] == "order-service"
    assert "database" in body
    assert "broker" in body
