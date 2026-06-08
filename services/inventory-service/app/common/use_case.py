from abc import ABC, abstractmethod
from typing import Generic, TypeVar

Input = TypeVar("Input")
Output = TypeVar("Output")


class UseCase(ABC, Generic[Input, Output]):
    """Base contract for use cases that receive input parameters."""

    @abstractmethod
    def execute(self, params: Input) -> Output:
        """Execute business flow and return a result."""
        ...
