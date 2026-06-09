from sqlalchemy.orm import Session, sessionmaker

from app.features.inventory.application.contracts.unit_of_work import UnitOfWork
from app.features.inventory.infrastructure.persistence.sqlalchemy_inventory_repository import (
    SqlAlchemyInventoryRepository,
)


class SqlAlchemyUnitOfWork(UnitOfWork):
    """SQLAlchemy Unit of Work.

    Opens a session on enter, exposes the bound ``inventory`` repository, and
    guarantees the session is closed on exit regardless of outcome.
    """

    def __init__(self, session_factory: sessionmaker) -> None:
        self._session_factory = session_factory
        self._session: Session | None = None

    def __enter__(self) -> "SqlAlchemyUnitOfWork":
        self._session = self._session_factory()
        self.inventory = SqlAlchemyInventoryRepository(self._session)
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        if exc_type is not None:
            self.rollback()
        if self._session is not None:
            self._session.close()

    def commit(self) -> None:
        if self._session is None:
            raise RuntimeError("UnitOfWork not entered")
        self._session.commit()

    def rollback(self) -> None:
        if self._session is not None:
            self._session.rollback()
