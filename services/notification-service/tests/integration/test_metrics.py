"""Integration tests for the /metrics endpoint in notification-service."""

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration

CUSTOM_METRICS = [
    "edo_events_processed_total",
    "edo_events_dlq_total",
    "edo_events_retried_total",
    "edo_event_processing_seconds",
]


def test_should_return_200_on_metrics_endpoint(client: TestClient) -> None:
    response = client.get("/metrics")

    assert response.status_code == 200


def test_should_return_prometheus_text_format(client: TestClient) -> None:
    response = client.get("/metrics")

    content_type = response.headers.get("content-type", "")
    assert content_type.startswith("text/plain")


def test_should_expose_all_custom_business_metrics(client: TestClient) -> None:
    body = client.get("/metrics").text

    for metric in CUSTOM_METRICS:
        assert f"# HELP {metric}" in body, f"Missing HELP line for {metric}"
        assert f"# TYPE {metric}" in body, f"Missing TYPE line for {metric}"
