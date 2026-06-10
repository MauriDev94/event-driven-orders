"""Retry/DLQ decision logic shared by every consumer's retry dispatcher.

Pure logic, no I/O: given how many times a message has already been retried
and how its failure was classified, decide whether to retry it (and on which
backoff stage) or send it straight to the dead-letter queue.

Backoff schedule: 5s -> 30s -> 2m. After ``MAX_RETRIES`` transient failures
(or on the first permanent failure) the message goes to the DLQ.

Error classification:
- PERMANENT: the message itself is the problem (malformed JSON, schema
  validation failure, unknown ``event_type``) — retrying changes nothing.
- TRANSIENT: everything else (DB errors, broker hiccups, SMTP timeouts) —
  worth retrying with backoff.
"""

import json
from dataclasses import dataclass
from enum import Enum, auto

from pydantic import ValidationError

RETRY_COUNT_HEADER = "x-retry-count"

# (queue name suffix, TTL in milliseconds) per backoff stage.
RETRY_STAGES: tuple[tuple[str, int], ...] = (
    ("retry-5s", 5_000),
    ("retry-30s", 30_000),
    ("retry-2m", 120_000),
)
MAX_RETRIES = len(RETRY_STAGES)

_PERMANENT_EXCEPTIONS: tuple[type[Exception], ...] = (
    ValidationError,
    json.JSONDecodeError,
    ValueError,
)


class ErrorClass(Enum):
    TRANSIENT = auto()
    PERMANENT = auto()


class RetryAction(Enum):
    RETRY = auto()
    DEAD_LETTER = auto()


@dataclass(frozen=True)
class RetryDecision:
    action: RetryAction
    retry_queue_suffix: str | None = None
    delay_ms: int | None = None
    next_retry_count: int | None = None


def classify_exception(exc: Exception) -> ErrorClass:
    """Classify a handler failure as TRANSIENT (retryable) or PERMANENT (DLQ)."""
    if isinstance(exc, _PERMANENT_EXCEPTIONS):
        return ErrorClass.PERMANENT
    return ErrorClass.TRANSIENT


def decide_retry(retry_count: int, error_class: ErrorClass) -> RetryDecision:
    """Decide what to do with a message that just failed processing.

    PERMANENT errors and retries-exhausted both dead-letter immediately.
    Otherwise, return the next backoff stage (queue suffix + TTL).
    """
    if error_class is ErrorClass.PERMANENT or retry_count >= MAX_RETRIES:
        return RetryDecision(action=RetryAction.DEAD_LETTER)

    suffix, delay_ms = RETRY_STAGES[retry_count]
    return RetryDecision(
        action=RetryAction.RETRY,
        retry_queue_suffix=suffix,
        delay_ms=delay_ms,
        next_retry_count=retry_count + 1,
    )
