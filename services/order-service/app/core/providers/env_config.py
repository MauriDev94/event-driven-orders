from functools import lru_cache

from app.core.config.env_config import EnvConfig


@lru_cache
def get_env_config() -> EnvConfig:
    """Return cached environment configuration for dependency injection."""
    return EnvConfig()
