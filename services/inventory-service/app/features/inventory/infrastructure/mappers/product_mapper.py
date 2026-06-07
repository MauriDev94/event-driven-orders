from uuid import uuid4

from app.features.inventory.domain.entities.product import Product
from app.features.inventory.infrastructure.models.product_model import ProductModel


def map_product_model_to_entity(model: ProductModel) -> Product:
    """Convert an ORM model into a domain entity."""
    return Product(
        id=model.id,
        sku=model.sku,
        available_quantity=model.available_quantity,
    )


def map_product_entity_to_model(entity: Product) -> ProductModel:
    """Convert a domain entity into a new ORM model."""
    return ProductModel(
        id=entity.id or str(uuid4()),
        sku=entity.sku,
        available_quantity=entity.available_quantity,
    )
