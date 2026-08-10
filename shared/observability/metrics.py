"""Business-level Prometheus metrics for event-driven-orders.

All metrics use the default prometheus_client registry so they appear
automatically on every service's /metrics endpoint (via
prometheus-fastapi-instrumentator).

Keep this module free of service-specific imports — it is shared across
all three services.
"""

from prometheus_client import Counter, Histogram

EVENTS_PROCESSED = Counter(
    "edo_events_processed_total",
    "Domain events successfully processed by consumers",
    ["service", "event_type"],
)

EVENTS_DLQ = Counter(
    "edo_events_dlq_total",
    "Events dead-lettered after exhausting retries or on permanent failure",
    ["queue"],
)

EVENTS_RETRIED = Counter(
    "edo_events_retried_total",
    "Retry attempts across all queues",
    ["queue"],
)

EVENT_PROCESSING_SECONDS = Histogram(
    "edo_event_processing_seconds",
    "Handler processing latency in seconds",
    ["service"],
    buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5],
)
