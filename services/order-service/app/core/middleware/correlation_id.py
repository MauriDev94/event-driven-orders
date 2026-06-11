"""Correlation id + request logging middleware.

Combines two cross-cutting concerns in a single ASGI middleware so a request
is only wrapped once:

1. **Correlation id**: read ``X-Correlation-ID`` from the incoming request,
   or generate a UUID4 if absent. Bound to the structlog context for the
   duration of the request — every log line emitted while handling it
   (including the ``OrderCreated`` event published downstream, see
   ``order_event_mapper``) carries it — and echoed back in the response
   header so callers can correlate their own logs.

2. **Request logging**: one structured log line per request with method,
   path, status code and latency in milliseconds.
"""

import time
import uuid

import structlog
from fastapi import Request
from shared.observability.context import bound_correlation_id
from starlette.responses import Response

logger = structlog.get_logger(__name__)

CORRELATION_ID_HEADER = "X-Correlation-ID"


async def correlation_id_middleware(request: Request, call_next) -> Response:
    correlation_id = request.headers.get(CORRELATION_ID_HEADER) or str(uuid.uuid4())

    with bound_correlation_id(correlation_id):
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - start) * 1000

        logger.info(
            "request completed",
            method=request.method,
            path=request.url.path,
            status_code=response.status_code,
            duration_ms=round(duration_ms, 2),
        )

    response.headers[CORRELATION_ID_HEADER] = correlation_id
    return response
