from abc import ABC, abstractmethod


class TokenVerifier(ABC):
    """Port: checks a session token and returns the customer it names."""

    @abstractmethod
    def verify(self, token: str) -> str:
        """Return the customer id, or raise ``UnauthorizedError``."""
