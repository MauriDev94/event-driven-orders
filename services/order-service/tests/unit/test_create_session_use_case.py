import re
import secrets
from unittest.mock import Mock

import pytest

from app.common.identifiers import ID_MAX_LENGTH, ID_PATTERN
from app.features.session.application.contracts.token_issuer import IssuedToken, TokenIssuer
from app.features.session.application.usecases.create_session_use_case import CreateSession

pytestmark = pytest.mark.unit


def _create_session(issuer: Mock) -> CreateSession:
    return CreateSession(issuer)


def _issuer(token: str | None = None) -> Mock:
    issuer = Mock(spec=TokenIssuer)
    issuer.issue.return_value = IssuedToken(
        access_token=token or secrets.token_urlsafe(16), expires_in=60
    )
    return issuer


def test_should_issue_a_token_for_a_valid_customer_id() -> None:
    issuer = _issuer()

    _create_session(issuer).execute(None)

    customer_id = issuer.issue.call_args.args[0]
    assert re.match(ID_PATTERN, customer_id)
    assert len(customer_id) <= ID_MAX_LENGTH


def test_should_return_what_the_issuer_returns() -> None:
    token = secrets.token_urlsafe(16)

    result = _create_session(_issuer(token)).execute(None)

    assert result.access_token == token
    assert result.expires_in == 60


def test_should_use_a_new_customer_id_every_time() -> None:
    issuer = _issuer()
    use_case = _create_session(issuer)

    use_case.execute(None)
    use_case.execute(None)

    first, second = (call.args[0] for call in issuer.issue.call_args_list)
    assert first != second
