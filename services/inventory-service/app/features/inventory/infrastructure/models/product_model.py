from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.data.source.local.sql_alchemy_base import SqlAlchemyBase


class ProductModel(SqlAlchemyBase):
    """SQLAlchemy model for product stock."""

    __tablename__ = "products"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    sku: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    available_quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
