from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# RFC 7518 section 3.2: an HS256 key is at least as long as the hash output.
MIN_AUTH_SECRET_BYTES = 32


class EnvConfig(BaseSettings):
    """order-service settings loaded from environment variables.

    Defaults target a local run so the app boots (and ``/health`` answers)
    even without infrastructure; compose overrides them for the real stack.
    Secrets are ``SecretStr`` and validation errors don't echo the input, so
    neither a repr, a dump nor a failed startup prints them.
    """

    # Broker
    # No credentials in the default: aio-pika falls back to RabbitMQ's
    # default `guest` user.
    rabbitmq_url: str = "amqp://localhost:5672/"

    # Database (database-per-service: this service owns the `orders` DB)
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "orders"
    # Never a password literal in code; compose and CI always set it.
    db_password: SecretStr = SecretStr("")
    db_name: str = "orders"

    # HS256 key of the session tokens (ADR-0027), shared with
    # assistant-service. No default: the service does not start without it.
    # Compose and `make env` provide it; never a literal in code.
    auth_token_secret: SecretStr

    @field_validator("auth_token_secret")
    @classmethod
    def _secret_is_long_enough(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value().encode("utf-8")) < MIN_AUTH_SECRET_BYTES:
            raise ValueError(f"AUTH_TOKEN_SECRET must be at least {MIN_AUTH_SECRET_BYTES} bytes")
        return value

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        hide_input_in_errors=True,
    )
