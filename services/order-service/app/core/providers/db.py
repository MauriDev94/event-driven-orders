from collections.abc import Generator
from functools import lru_cache

from sqlalchemy.orm import Session

from app.core.data.source.local.database import Database
from app.core.providers.env_config import get_env_config


@lru_cache
def get_database() -> Database:
    """Return the process-wide database: one engine, so the requests and the
    consumer share one connection pool. A ``Database`` per call would open a
    new connection per request and, when the request ends in an exception,
    leave it idle until the garbage collector frees the engine."""
    return Database(get_env_config())


def get_db_session() -> Generator[Session, None, None]:
    """Yield a database session for request-scoped dependencies."""
    yield from get_database().get_session()
