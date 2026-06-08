from pydantic_settings import BaseSettings, SettingsConfigDict


class EnvConfig(BaseSettings):
    """inventory-service settings loaded from environment variables.

    Defaults target a local run; compose overrides them for the real stack.
    """

    # Broker
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672/"

    # Database (database-per-service: this service owns the `inventory` DB)
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "inventory"
    db_password: str = "inventory"
    db_name: str = "inventory"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )
