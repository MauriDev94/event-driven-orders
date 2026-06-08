from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.exceptions.exceptions import DatabaseError
from app.features.inventory.application.contracts.inventory_repository import (
    InventoryRepository,
)
from app.features.inventory.domain.entities.product import Product
from app.features.inventory.infrastructure.mappers.product_mapper import (
    map_product_entity_to_model,
    map_product_model_to_entity,
)
from app.features.inventory.infrastructure.models.product_model import ProductModel


class SqlAlchemyInventoryRepository(InventoryRepository):
    """SQLAlchemy implementation of the InventoryRepository port."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def get_by_sku(self, sku: str) -> Product | None:
        try:
            model = self.session.query(ProductModel).filter(ProductModel.sku == sku).first()
        except SQLAlchemyError as exc:
            raise DatabaseError("failed to retrieve product") from exc
        return map_product_model_to_entity(model) if model is not None else None

    def save(self, product: Product) -> Product:
        try:
            model = map_product_entity_to_model(product)
            merged = self.session.merge(model)
            self.session.commit()
            self.session.refresh(merged)
        except SQLAlchemyError as exc:
            self.session.rollback()
            raise DatabaseError("failed to save product") from exc
        return map_product_model_to_entity(merged)
