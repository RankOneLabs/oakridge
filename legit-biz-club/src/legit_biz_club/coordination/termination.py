"""Termination policies for the incremental coordination mode.

The :meth:`TerminationPolicy.should_terminate` signature gained a
``recent_versions`` parameter for stability-aware termination. The
default value (empty tuple) keeps callers source-compatible, but
**subclasses that override `should_terminate` must accept the new
parameter** — Python's ABC method overrides aren't covariant on
signature. Accepted as a deliberate breaking change since this
package has no external consumers yet (pre-1.0).

A :class:`TerminationPolicy` decides when the project layer should stop
accepting new proposals. v1 ships two implementations:

- :class:`KCommitsPerAgent` (k=5 default): fires when every enrolled
  agent has had at least k successful applies. Predictable and
  comparable across ensemble sizes.
- :class:`KCommitsOrStable` (k=5, stable_n=2 defaults): same k-commits
  ceiling, but also fires early when the artifact's content has been
  byte-identical for the last ``stable_n`` consecutive applies. Saves
  the cost of agents producing redundant no-op commits once they've
  converged on prose-stable content.

Both are pluggable behind the same interface; future eval-threshold or
operator-stop policies (deferred to v2+) slot in the same way.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence


class TerminationPolicy(ABC):
    """Decide whether the incremental loop should stop."""

    @abstractmethod
    def should_terminate(
        self,
        commit_counts: Mapping[str, int],
        recent_versions: Sequence[str] = (),
    ) -> bool:
        """Return ``True`` when the project's incremental loop should halt.

        ``commit_counts`` maps ``agent_id`` to the number of successfully
        applied proposals for that agent in this project. Empty mapping
        is a degenerate input — implementations should choose a
        reasonable default (typically: don't terminate yet).

        ``recent_versions`` is the sequence of artifact-version hashes
        produced by successful applies, in apply order. Stability-aware
        policies (e.g., :class:`KCommitsOrStable`) read the tail of
        this sequence; commit-count-only policies ignore it.
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

    def should_terminate(
        self,
        commit_counts: Mapping[str, int],
        recent_versions: Sequence[str] = (),  # noqa: ARG002
    ) -> bool:
        if not commit_counts:
            return False
        return all(c >= self.k for c in commit_counts.values())


class KCommitsOrStable(TerminationPolicy):
    """Terminate when k-commits-per-agent fires OR content stabilizes.

    Two termination conditions, OR'd:

    1. Every agent has reached ``k`` successful commits (the
       :class:`KCommitsPerAgent` ceiling — predictable upper bound).
    2. The last ``stable_n`` consecutive successful applies produced
       byte-identical content (i.e., the most recent ``stable_n + 1``
       version hashes are all the same — agents agreed on the artifact
       and further commits are no-ops).

    Defaults are ``k=5, stable_n=2``: same upper bound as the existing
    policy, terminate after two consecutive no-ops. ``stable_n=2`` is
    deliberately conservative — a single no-op might be a transient
    agreement that the next round dispels; two in a row is a stronger
    signal of stability.

    Real LLMs do reach byte-stable content during incremental
    coordination (observed in v0 smoke runs), so this policy is the
    cost-saver default for ``ProjectCoordinator`` — switch back to
    :class:`KCommitsPerAgent` if you want a fixed call budget for
    cross-condition cost comparison in study runs.
    """

    def __init__(self, k: int = 5, stable_n: int = 2) -> None:
        if k <= 0:
            raise ValueError(f"k must be positive, got {k}")
        if stable_n <= 0:
            raise ValueError(f"stable_n must be positive, got {stable_n}")
        self.k = k
        self.stable_n = stable_n

    def should_terminate(
        self,
        commit_counts: Mapping[str, int],
        recent_versions: Sequence[str] = (),
    ) -> bool:
        if commit_counts and all(c >= self.k for c in commit_counts.values()):
            return True
        # Need at least stable_n+1 versions to observe stable_n
        # consecutive no-ops.
        if len(recent_versions) >= self.stable_n + 1:
            tail = recent_versions[-(self.stable_n + 1) :]
            if len(set(tail)) == 1:
                return True
        return False
