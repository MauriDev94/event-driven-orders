"""Event logging helpers shared by every consumer.

``log_event_received`` emits the standard ``event received`` log line that
makes a flow traceable end-to-end (issue #31). Centralizing it here keeps
the four required fields — ``event_type``, ``event_id``, ``correlation_id``,
``order_id`` — consistent across all consumers; adding a new consumer-side
log call without going through this helper is the canonical way to miss a
field by accident.
"""

import structlog

from shared.contracts.base_event import BaseEvent


def log_event_received(logger: structlog.stdlib.BoundLogger, event: BaseEvent) -> None:
    """Emit an ``event received`` log carrying the event's tracing fields.

    The structlog contextvar bound by ``shared.messaging.retry_dispatcher``
    carries the same ``correlation_id``; this helper surfaces it as an
    explicit log field too, so a single log entry is self-describing without
    relying on contextvar state.
    """
    logger.info(
        "event received",
        event_type=event.event_type,
        event_id=event.event_id,
        correlation_id=event.correlation_id,
        order_id=event.order_id,
    )
