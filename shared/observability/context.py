"""Correlation id propagation via structlog contextvars.

A thin wrapper so application code doesn't import ``structlog`` directly to
read or bind the correlation id — keeps the dependency on structlog confined
to the logging layer.
"""

from collections.abc import Iterator
from contextlib import contextmanager

import structlog

CORRELATION_ID_KEY = "correlation_id"


def get_correlation_id() -> str | None:
    """Return the correlation id bound to the current context, if any."""
    return structlog.contextvars.get_contextvars().get(CORRELATION_ID_KEY)


@contextmanager
def bound_correlation_id(correlation_id: str) -> Iterator[None]:
    """Bind ``correlation_id`` to the logging context for the block's duration."""
    tokens = structlog.contextvars.bind_contextvars(
        **{CORRELATION_ID_KEY: correlation_id}
    )
    try:
        yield
    finally:
        structlog.contextvars.reset_contextvars(**tokens)
