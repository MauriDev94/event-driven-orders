from uuid import uuid4

from app.common.use_case import UseCase
from app.features.session.application.contracts.token_issuer import IssuedToken, TokenIssuer


class CreateSession(UseCase[None, IssuedToken]):
    """Open an anonymous session: a new random customer id and a token for it.

    Nothing is stored (ADR-0027): the token is the whole identity. A UUID is
    36 characters of ``[0-9a-f-]``, so it satisfies the order id rules.
    """

    def __init__(self, token_issuer: TokenIssuer) -> None:
        self.token_issuer = token_issuer

    def execute(self, params: None) -> IssuedToken:
        return self.token_issuer.issue(str(uuid4()))
