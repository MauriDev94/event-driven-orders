from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class IssuedToken:
    access_token: str
    expires_in: int  # seconds


class TokenIssuer(ABC):
    """Port: signs a session token for a customer."""

    @abstractmethod
    def issue(self, customer_id: str) -> IssuedToken: ...
