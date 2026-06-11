import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration


def test_should_generate_correlation_id_header_when_absent(client: TestClient) -> None:
    response = client.get("/health")

    assert response.headers["X-Correlation-ID"]


def test_should_echo_provided_correlation_id_header(client: TestClient) -> None:
    response = client.get("/health", headers={"X-Correlation-ID": "my-trace-id"})

    assert response.headers["X-Correlation-ID"] == "my-trace-id"
