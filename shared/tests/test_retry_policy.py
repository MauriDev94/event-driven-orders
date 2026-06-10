"""Unit tests for the retry/DLQ decision logic (pure, no I/O).

Covers:
- ``classify_exception``: transient (retryable) vs permanent (straight to DLQ).
- ``decide_retry``: backoff stage selection and the retries-exhausted -> DLQ path.
"""

import json

import pytest
from pydantic import BaseModel, ValidationError

from shared.messaging.retry_policy import (
    MAX_RETRIES,
    RETRY_STAGES,
    ErrorClass,
    RetryAction,
    classify_exception,
    decide_retry,
)

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# classify_exception
# ---------------------------------------------------------------------------


class _Model(BaseModel):
    order_id: str


def test_should_classify_validation_error_as_permanent() -> None:
    try:
        _Model.model_validate({})
    except ValidationError as exc:
        assert classify_exception(exc) is ErrorClass.PERMANENT


def test_should_classify_json_decode_error_as_permanent() -> None:
    try:
        json.loads("not json")
    except json.JSONDecodeError as exc:
        assert classify_exception(exc) is ErrorClass.PERMANENT


def test_should_classify_value_error_as_permanent() -> None:
    assert (
        classify_exception(ValueError("unknown event_type 'foo'"))
        is ErrorClass.PERMANENT
    )


def test_should_classify_connection_error_as_transient() -> None:
    assert (
        classify_exception(ConnectionError("broker unreachable"))
        is ErrorClass.TRANSIENT
    )


def test_should_classify_generic_exception_as_transient() -> None:
    assert classify_exception(RuntimeError("db timeout")) is ErrorClass.TRANSIENT


# ---------------------------------------------------------------------------
# decide_retry
# ---------------------------------------------------------------------------


def test_should_retry_with_first_backoff_stage_on_first_transient_failure() -> None:
    decision = decide_retry(retry_count=0, error_class=ErrorClass.TRANSIENT)

    assert decision.action is RetryAction.RETRY
    assert decision.retry_queue_suffix == RETRY_STAGES[0][0]
    assert decision.delay_ms == RETRY_STAGES[0][1]
    assert decision.next_retry_count == 1


def test_should_advance_through_backoff_stages_on_repeated_transient_failures() -> None:
    for retry_count, (suffix, delay_ms) in enumerate(RETRY_STAGES):
        decision = decide_retry(
            retry_count=retry_count, error_class=ErrorClass.TRANSIENT
        )

        assert decision.action is RetryAction.RETRY
        assert decision.retry_queue_suffix == suffix
        assert decision.delay_ms == delay_ms
        assert decision.next_retry_count == retry_count + 1


def test_should_dead_letter_when_retries_exhausted() -> None:
    decision = decide_retry(retry_count=MAX_RETRIES, error_class=ErrorClass.TRANSIENT)

    assert decision.action is RetryAction.DEAD_LETTER
    assert decision.retry_queue_suffix is None
    assert decision.delay_ms is None
    assert decision.next_retry_count is None


def test_should_dead_letter_permanent_errors_regardless_of_retry_count() -> None:
    decision = decide_retry(retry_count=0, error_class=ErrorClass.PERMANENT)

    assert decision.action is RetryAction.DEAD_LETTER
    assert decision.retry_queue_suffix is None
