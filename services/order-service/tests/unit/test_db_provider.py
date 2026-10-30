import pytest
from sqlalchemy.engine import Engine

from app.core.providers.db import get_db_session

pytestmark = pytest.mark.unit


def _engine_of_next_session() -> Engine:
    sessions = get_db_session()
    try:
        engine = next(sessions).get_bind()
        assert isinstance(engine, Engine)
        return engine
    finally:
        sessions.close()


def test_should_share_one_engine_when_two_requests_ask_for_a_session() -> None:
    assert _engine_of_next_session() is _engine_of_next_session()
