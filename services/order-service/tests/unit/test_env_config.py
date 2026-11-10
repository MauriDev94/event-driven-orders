import secrets

import pytest
from pydantic import ValidationError

from app.core.config.env_config import EnvConfig

pytestmark = pytest.mark.unit

MIN_AUTH_SECRET_BYTES = 32  # ADR-0027


def _config() -> EnvConfig:
    # `_env_file=None`: the test must not depend on a local env file.
    return EnvConfig(_env_file=None)


def _secret_of_bytes(size: int) -> str:
    """A generated ASCII secret of exactly `size` bytes."""
    return secrets.token_hex(size)[:size]


def test_should_load_a_secret_of_32_bytes_or_more(monkeypatch) -> None:
    secret = secrets.token_urlsafe(32)
    monkeypatch.setenv("AUTH_TOKEN_SECRET", secret)

    assert _config().auth_token_secret.get_secret_value() == secret


def test_should_refuse_a_secret_under_32_bytes(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_TOKEN_SECRET", _secret_of_bytes(MIN_AUTH_SECRET_BYTES - 1))

    with pytest.raises(ValidationError):
        _config()


def test_should_accept_exactly_32_bytes(monkeypatch) -> None:
    secret = _secret_of_bytes(MIN_AUTH_SECRET_BYTES)
    monkeypatch.setenv("AUTH_TOKEN_SECRET", secret)

    assert _config().auth_token_secret.get_secret_value() == secret


def test_should_count_bytes_and_not_characters(monkeypatch) -> None:
    # 16 two-byte characters are 32 bytes: accepted. 15 of them plus one
    # ASCII character are 31 bytes: refused.
    two_byte = "é"
    monkeypatch.setenv("AUTH_TOKEN_SECRET", two_byte * 16)
    assert len(_config().auth_token_secret.get_secret_value().encode()) == 32

    monkeypatch.setenv("AUTH_TOKEN_SECRET", two_byte * 15 + "a")
    with pytest.raises(ValidationError):
        _config()


def test_should_refuse_an_empty_secret(monkeypatch) -> None:
    monkeypatch.setenv("AUTH_TOKEN_SECRET", "")

    with pytest.raises(ValidationError):
        _config()


def test_should_refuse_to_start_without_a_secret(monkeypatch) -> None:
    monkeypatch.delenv("AUTH_TOKEN_SECRET", raising=False)

    with pytest.raises(ValidationError):
        _config()


def test_should_not_echo_a_rejected_secret_in_the_error(monkeypatch) -> None:
    short = _secret_of_bytes(MIN_AUTH_SECRET_BYTES - 1)
    monkeypatch.setenv("AUTH_TOKEN_SECRET", short)

    with pytest.raises(ValidationError) as excinfo:
        _config()

    assert short not in str(excinfo.value)
    assert f"at least {MIN_AUTH_SECRET_BYTES} bytes" in str(excinfo.value)


def test_should_not_show_the_secrets_in_repr_or_dump(monkeypatch) -> None:
    secret = secrets.token_urlsafe(32)
    db_secret = secrets.token_urlsafe(16)
    monkeypatch.setenv("AUTH_TOKEN_SECRET", secret)
    monkeypatch.setenv("DB_PASSWORD", db_secret)
    config = _config()

    shown = repr(config) + str(config) + repr(config.model_dump())

    assert secret not in shown
    assert db_secret not in shown
    assert config.db_password.get_secret_value() == db_secret
