"""create inventory tables and seed initial products

Revision ID: a1b2c3d4e5f6
Revises:
Create Date: 2026-06-09 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "products",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("sku", sa.String(length=64), nullable=False),
        sa.Column("available_quantity", sa.Integer(), nullable=False, server_default="0"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sku"),
    )
    op.create_index(op.f("ix_products_sku"), "products", ["sku"], unique=True)

    op.create_table(
        "processed_events",
        sa.Column("event_id", sa.String(length=36), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("event_id"),
    )

    # Seed: initial product catalog with enough stock to test the full flow.
    # These are the products that the order-service can reference out of the box.
    op.execute(
        sa.text(
            "INSERT INTO products (id, sku, available_quantity) VALUES "
            "('prod-001', 'SKU-001', 100), "
            "('prod-002', 'SKU-002', 50), "
            "('prod-003', 'SKU-003', 25), "
            "('prod-004', 'SKU-004', 10), "
            "('prod-005', 'SKU-005', 5)"
        )
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_products_sku"), table_name="products")
    op.drop_table("products")
    op.drop_table("processed_events")
