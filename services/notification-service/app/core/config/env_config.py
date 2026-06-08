from pydantic_settings import BaseSettings, SettingsConfigDict


class EnvConfig(BaseSettings):
    """notification-service settings loaded from environment variables.

    No database: this service is a pure consumer that sends email via SMTP.
    Defaults target a local run; compose overrides them for the real stack.
    """

    # Broker
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672/"

    # SMTP (Mailhog locally)
    smtp_host: str = "localhost"
    smtp_port: int = 1025
    smtp_sender_email: str = "no-reply@event-driven-orders.local"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )
