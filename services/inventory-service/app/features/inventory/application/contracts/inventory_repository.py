from abc import ABC, abstractmethod

from app.features.inventory.domain.entities.product import Product


class InventoryRepository(ABC):
    """Persistence port for products/stock. Implemented in infrastructure."""

    @abstractmethod
    def get_by_sku(self, sku: str) -> Product | None:
        """Return the product by SKU, or None if it does not exist."""
        ...

    @abstractmethod
    def save(self, product: Product) -> Product:
        """Persist changes to a product's stock."""
        ...
