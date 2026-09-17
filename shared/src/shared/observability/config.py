"""Centralized structured (JSON) logging configuration.

Every service calls ``configure_logging(service_name)`` once at startup. The
result: every log line — whether emitted via ``structlog.get_logger()`` or
via the stdlib ``logging`` module (used pervasively across the codebase) — is
a single JSON object with ``timestamp``, ``level``, ``logger``, ``message``,
``service`` and any contextvars bound via ``shared.logging.context``
(notably ``correlation_id``).
"""

import logging
import sys
from typing import TextIO

import structlog


def configure_logging(
    service_name: str, *, level: int = logging.INFO, stream: TextIO | None = None
) -> None:
    """Configure structlog and the stdlib root logger to emit JSON lines."""
    output = stream if stream is not None else sys.stdout

    timestamper = structlog.processors.TimeStamper(fmt="iso", key="timestamp")
    add_service_name = _add_service_name(service_name)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            add_service_name,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            timestamper,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        # False so tests using structlog.testing.capture_logs() (which swaps
        # the processor chain at runtime) see the new chain even for loggers
        # already obtained via get_logger() at module import time.
        cache_logger_on_first_use=False,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=[
            structlog.contextvars.merge_contextvars,
            add_service_name,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            timestamper,
        ],
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.EventRenamer("message"),
            structlog.processors.JSONRenderer(),
        ],
    )

    handler = logging.StreamHandler(output)
    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.handlers = [handler]
    root_logger.setLevel(level)


def _add_service_name(service_name: str) -> structlog.types.Processor:
    def processor(
        logger: object, method_name: str, event_dict: structlog.types.EventDict
    ) -> structlog.types.EventDict:
        event_dict["service"] = service_name
        return event_dict

    return processor
