"""Behavior test: importing app.main configures structured (JSON) logging
tagged with this service's name.

See ``shared/tests/test_observability_config.py`` for the generic
``configure_logging`` contract; this test only checks the wiring.
"""

import pytest
import structlog

from app.main import app  # noqa: F401 - import triggers configure_logging

pytestmark = pytest.mark.unit


def test_should_tag_logs_with_notification_service_name() -> None:
    cap = structlog.testing.LogCapture()
    old_processors = structlog.get_config()["processors"]
    structlog.configure(processors=old_processors[:-1] + [cap])
    try:
        structlog.get_logger("test.logger").info("notification sent")
    finally:
        structlog.configure(processors=old_processors)

    assert cap.entries[-1]["service"] == "notification-service"
