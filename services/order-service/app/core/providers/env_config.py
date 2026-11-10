from functools import lru_cache

from app.core.config.env_config import EnvConfig


@lru_cache
def get_env_config() -> EnvConfig:
    """Return cached environment configuration for dependency injection."""
    # The required secret comes from the environment, which mypy cannot see.
    return EnvConfig()  # type: ignore[call-arg]
