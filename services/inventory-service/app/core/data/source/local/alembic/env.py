import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Priority: DATABASE_URL (managed DB) > individual db_* vars (local dev / CI).
database_url = os.getenv("DATABASE_URL")
if not database_url:
    from app.core.config.env_config import EnvConfig

    _cfg = EnvConfig()
    database_url = (
        f"postgresql+psycopg2://{_cfg.db_user}:{_cfg.db_password}"
        f"@{_cfg.db_host}:{_cfg.db_port}/{_cfg.db_name}"
    )

if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)

from app.core.data.source.local.sql_alchemy_base import SqlAlchemyBase  # noqa: E402

# Import models so their tables register on the metadata for autogenerate.
from app.features.inventory.infrastructure.models import (  # noqa: E402, F401
    processed_event_model,
    product_model,
)

target_metadata = SqlAlchemyBase.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emits SQL, no DBAPI required)."""
    context.configure(
        url=database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode against a live connection."""
    engine = create_engine(database_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
