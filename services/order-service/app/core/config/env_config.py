from pydantic_settings import BaseSettings, SettingsConfigDict


class EnvConfig(BaseSettings):
    """order-service settings loaded from environment variables.

    Defaults target a local run so the app boots (and ``/health`` answers)
    even without infrastructure; compose overrides them for the real stack.
    """

    # Broker
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672/"

    # Database (database-per-service: this service owns the `orders` DB)
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "orders"
    db_password: str = "orders"
    db_name: str = "orders"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )
