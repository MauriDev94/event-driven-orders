"""Behavior tests for the shared structured-logging configuration.

``configure_logging`` is hard to test with pure TDD (it mutates global
logging state), so these are behavior tests: configure logging against an
in-memory stream, emit a log line, and assert the captured output is valid
JSON with the expected fields.
"""

import io
import json
import logging

import pytest
import structlog

from shared.observability.config import configure_logging
from shared.observability.context import bound_correlation_id, get_correlation_id

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def _reset_structlog():
    yield
    structlog.reset_defaults()
    logging.getLogger().handlers = []


def _last_json_line(stream) -> dict:
    lines = stream.getvalue().strip().splitlines()
    return json.loads(lines[-1])


def test_should_emit_json_with_expected_fields_for_structlog_logger() -> None:
    stream = io.StringIO()
    configure_logging("order-service", stream=stream)
    logger = structlog.get_logger("test.logger")

    with bound_correlation_id("corr-123"):
        logger.info("something happened", foo="bar")

    payload = _last_json_line(stream)
    assert payload["message"] == "something happened"
    assert payload["level"] == "info"
    assert payload["service"] == "order-service"
    assert payload["logger"] == "test.logger"
    assert payload["correlation_id"] == "corr-123"
    assert payload["foo"] == "bar"
    assert "timestamp" in payload


def test_should_omit_correlation_id_when_not_bound() -> None:
    stream = io.StringIO()
    configure_logging("order-service", stream=stream)
    logger = structlog.get_logger("test.logger")

    logger.info("no correlation here")

    payload = _last_json_line(stream)
    assert "correlation_id" not in payload


def test_should_route_stdlib_logging_through_structlog_json() -> None:
    stream = io.StringIO()
    configure_logging("inventory-service", stream=stream)

    with bound_correlation_id("corr-456"):
        logging.getLogger("stdlib.logger").info("plain message")

    payload = _last_json_line(stream)
    assert payload["message"] == "plain message"
    assert payload["service"] == "inventory-service"
    assert payload["logger"] == "stdlib.logger"
    assert payload["correlation_id"] == "corr-456"


def test_get_correlation_id_returns_none_when_not_bound() -> None:
    assert get_correlation_id() is None


def test_bound_correlation_id_sets_and_resets_context() -> None:
    with bound_correlation_id("abc-123"):
        assert get_correlation_id() == "abc-123"

    assert get_correlation_id() is None
