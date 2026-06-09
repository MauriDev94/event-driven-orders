from datetime import UTC, datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.data.source.local.sql_alchemy_base import SqlAlchemyBase


class ProcessedEventModel(SqlAlchemyBase):
    """Idempotency ledger: one row per consumed event.

    The ``event_id`` primary key is the idempotency guard — recording it inside
    the reservation transaction means a redelivered ``OrderCreated`` (RabbitMQ
    is at-least-once) is detected as a duplicate and skipped.
    """

    __tablename__ = "processed_events"

    event_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    processed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
