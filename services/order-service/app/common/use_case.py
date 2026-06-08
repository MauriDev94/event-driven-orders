from abc import ABC, abstractmethod
from typing import Generic, TypeVar

Input = TypeVar("Input")
Output = TypeVar("Output")


class UseCase(ABC, Generic[Input, Output]):
    """Base contract for synchronous use cases that receive input parameters."""

    @abstractmethod
    def execute(self, params: Input) -> Output:
        """Execute business flow and return a result."""
        ...


class AsyncUseCase(ABC, Generic[Input, Output]):
    """Base contract for asynchronous use cases.

    Used when orchestration must await an async port (e.g. publishing to the
    broker through ``EventPublisher``). Kept separate from ``UseCase`` so the
    sync/async boundary is explicit at the type level.
    """

    @abstractmethod
    async def execute(self, params: Input) -> Output:
        """Execute business flow and return a result."""
        ...
