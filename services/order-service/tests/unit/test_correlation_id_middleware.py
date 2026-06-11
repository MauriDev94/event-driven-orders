import pytest
import structlog
from starlette.requests import Request
from starlette.responses import Response

from app.core.middleware.correlation_id import (
    CORRELATION_ID_HEADER,
    correlation_id_middleware,
)

pytestmark = pytest.mark.unit


def _request(headers: dict[str, str] | None = None) -> Request:
    raw_headers = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/v1/orders",
        "headers": raw_headers,
    }
    return Request(scope)


async def test_should_generate_correlation_id_when_header_absent() -> None:
    async def call_next(request: Request) -> Response:
        return Response(status_code=200)

    response = await correlation_id_middleware(_request(), call_next)

    assert response.headers[CORRELATION_ID_HEADER]


async def test_should_reuse_correlation_id_from_header() -> None:
    async def call_next(request: Request) -> Response:
        return Response(status_code=200)

    response = await correlation_id_middleware(
        _request({CORRELATION_ID_HEADER: "trace-123"}), call_next
    )

    assert response.headers[CORRELATION_ID_HEADER] == "trace-123"


async def test_should_log_request_completion_with_structured_fields() -> None:
    async def call_next(request: Request) -> Response:
        return Response(status_code=201)

    # capture_logs() alone drops the configured processor chain (including
    # merge_contextvars), so wire a capture processor that still merges
    # contextvars to assert correlation_id ends up in the log entry.
    cap = structlog.testing.LogCapture()
    old_processors = structlog.get_config()["processors"]
    structlog.configure(processors=[structlog.contextvars.merge_contextvars, cap])
    try:
        await correlation_id_middleware(_request({CORRELATION_ID_HEADER: "trace-abc"}), call_next)
    finally:
        structlog.configure(processors=old_processors)

    [entry] = cap.entries
    assert entry["event"] == "request completed"
    assert entry["method"] == "GET"
    assert entry["path"] == "/v1/orders"
    assert entry["status_code"] == 201
    assert "duration_ms" in entry
    assert entry["correlation_id"] == "trace-abc"
