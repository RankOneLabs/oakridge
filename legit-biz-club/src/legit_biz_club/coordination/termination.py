"""Termination policies for the incremental coordination mode.

A :class:`TerminationPolicy` decides when the project layer should stop
accepting new proposals. v1 ships :class:`KCommitsPerAgent` (default
K=5) — fires when every enrolled agent has had at least K successful
applies. Behind the same interface as future eval-threshold or
operator-stop policies (deferred to v2+).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping


class TerminationPolicy(ABC):
    """Decide whether the incremental loop should stop."""

    @abstractmethod
    def should_terminate(self, commit_counts: Mapping[str, int]) -> bool:
        """Return ``True`` when the project's incremental loop should halt.

        ``commit_counts`` maps ``agent_id`` to the number of successfully
        applied proposals for that agent in this project. Empty mapping
        is a degenerate input — implementations should choose a
        reasonable default (typically: don't terminate yet).
        """


class KCommitsPerAgent(TerminationPolicy):
    """Terminate when every agent has had K successful commits.

    Default K=5; an n=5 ensemble does ~25 commit attempts before
    stopping. Comparable across ensemble sizes and doesn't depend on a
    convergence detector that rarely fires in v1.
    """

    def __init__(self, k: int = 5) -> None:
        if k <= 0:
            raise ValueError(f"k must be positive, got {k}")
        self.k = k

    def should_terminate(self, commit_counts: Mapping[str, int]) -> bool:
        if not commit_counts:
            return False
        return all(c >= self.k for c in commit_counts.values())
