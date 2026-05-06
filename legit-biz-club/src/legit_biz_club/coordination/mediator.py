"""Mediator: validates proposals and applies them to the artifact.

The mediator is the project layer's enforcement point for the
incremental coordination mode. It owns:

- The OCC check (proposal version vs current artifact version)
- Per-agent retry budgets and commit counts
- Atomic apply (read-validate-write under a single asyncio lock so
  proposals can't race their OCC check against each other's writes)

For v1, ``apply`` is naive: write the new content to the artifact path,
recompute the version. Diff/merge strategies and per-section apply are
v2 candidates once we have data on what the loop looks like in practice.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from legit_biz_club.coordination.proposal import (
    Proposal,
    ProposalOutcome,
    ProposalResult,
)
from legit_biz_club.coordination.version import compute_version
from legit_biz_club.core.models import Artifact, ArtifactType

logger = logging.getLogger(__name__)


class Mediator:
    """Coordinates proposals against a single artifact for one project."""

    def __init__(
        self,
        artifact: Artifact,
        agent_ids: list[str],
        *,
        retry_budget: int = 3,
        snapshot_dir: Path | None = None,
    ) -> None:
        if retry_budget <= 0:
            raise ValueError(
                f"retry_budget must be positive, got {retry_budget}"
            )
        self.artifact = artifact
        self._retry_budget_initial = retry_budget
        self._retry_remaining: dict[str, int] = {a: retry_budget for a in agent_ids}
        self._commit_counts: dict[str, int] = dict.fromkeys(agent_ids, 0)
        self._lock = asyncio.Lock()
        # Per-commit snapshot dir. When set, every successful apply
        # writes the new content to ``snapshot_dir/v{N:04d}.md`` so a
        # post-mortem can inspect how the artifact evolved across
        # commits. Best-effort observation: if the snapshot write
        # fails, the apply still succeeds — the artifact on disk is
        # source of truth, snapshots are observation.
        self._snapshot_dir = snapshot_dir
        self._snapshot_count = 0
        if snapshot_dir is not None:
            snapshot_dir.mkdir(parents=True, exist_ok=True)

    @property
    def commit_counts(self) -> dict[str, int]:
        """Snapshot of per-agent commit counts."""
        return dict(self._commit_counts)

    @property
    def retry_remaining(self) -> dict[str, int]:
        """Snapshot of per-agent retry budget remaining."""
        return dict(self._retry_remaining)

    async def reset_retry_budgets(self) -> None:
        """Restore every agent's retry budget to the initial value.

        Called by :class:`ProjectCoordinator` between coordination
        phases under ``incremental_then_converge``: an agent that
        burned its retry budget during incremental commits should still
        be allowed to land a converged or escalation-picked proposal,
        because consensus has no retry semantics — the budget check
        is meaningless for a one-shot apply.

        Acquires the same lock as :meth:`apply` so a reset can't race
        an in-flight apply's budget check at one of apply's
        ``await asyncio.to_thread`` yield points. The intended call
        pattern (strictly between phases) makes that race impossible
        in practice, but enforcing it in code is cheap and avoids
        bugs if a future caller reaches for this method outside the
        coordinator.
        """
        async with self._lock:
            for agent_id in self._retry_remaining:
                self._retry_remaining[agent_id] = self._retry_budget_initial

    async def current_state(self) -> tuple[str, str]:
        """Return ``(content, version)`` for the artifact's current state.

        Reads disk every call — the artifact is the authoritative source
        of truth, so we don't cache. Cheap for prose; if code artifacts
        grow large enough to matter, cache + invalidate on apply.
        """
        content = await asyncio.to_thread(self._read_content)
        version = compute_version(self.artifact, content=content)
        return content, version

    async def apply(self, proposal: Proposal) -> ProposalOutcome:
        """Validate and apply a proposal under the mediator's lock.

        The lock is held for the entire validate-write-rehash sequence
        so two proposals can't race a write between each other's OCC
        check and apply. The lock is released before the caller's
        workspace-event emission so external HTTP calls don't block
        other proposals.
        """
        async with self._lock:
            agent_id = proposal.agent_id
            if agent_id not in self._retry_remaining:
                return ProposalOutcome(
                    proposal=proposal,
                    result=ProposalResult.REJECTED_VALIDATION,
                    reason=f"unknown agent_id: {agent_id}",
                )
            if self._retry_remaining[agent_id] <= 0:
                return ProposalOutcome(
                    proposal=proposal,
                    result=ProposalResult.BUDGET_EXHAUSTED,
                    reason="retry budget exhausted",
                )
            current_content = await asyncio.to_thread(self._read_content)
            current_version = compute_version(
                self.artifact, content=current_content
            )
            if proposal.based_on_version != current_version:
                # State moved between agent's read and write. Charge a
                # retry, signal OCC reject so caller can re-fetch state
                # and try again.
                self._retry_remaining[agent_id] -= 1
                return ProposalOutcome(
                    proposal=proposal,
                    result=ProposalResult.REJECTED_OCC,
                    reason=(
                        f"based_on {proposal.based_on_version[:12]} "
                        f"but current is {current_version[:12]}"
                    ),
                )
            await asyncio.to_thread(self._write_content, proposal.new_content)
            new_version = compute_version(
                self.artifact, content=proposal.new_content
            )
            self._commit_counts[agent_id] += 1
            self._snapshot_count += 1
            if self._snapshot_dir is not None:
                await asyncio.to_thread(
                    self._write_snapshot,
                    self._snapshot_count,
                    proposal.new_content,
                )
            return ProposalOutcome(
                proposal=proposal,
                result=ProposalResult.APPLIED,
                new_version=new_version,
            )

    def _read_content(self) -> str:
        self._reject_directory_code()
        return self.artifact.path.read_text(encoding="utf-8")

    def _write_content(self, content: str) -> None:
        self._reject_directory_code()
        # Atomic-ish: write to a sibling tmpfile then rename. POSIX
        # rename is atomic on the same filesystem; a mid-write crash
        # leaves the previous version intact rather than truncated.
        tmp = self.artifact.path.with_suffix(
            self.artifact.path.suffix + ".tmp"
        )
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(self.artifact.path)

    def _write_snapshot(self, n: int, content: str) -> None:
        """Best-effort per-commit snapshot.

        Failures here are logged and swallowed — the artifact on disk
        is already the source of truth, and an observability sidecar
        shouldn't fail the apply (which has already committed).

        Snapshot extension matches the artifact's so post-mortem
        tooling (syntax highlighters, formatters, type checkers) sees
        the right file type — ``feature.py`` snapshots become
        ``v0001.py``, not ``v0001.md``.
        """
        assert self._snapshot_dir is not None  # guarded at the call site
        try:
            suffix = self.artifact.path.suffix or ".txt"
            path = self._snapshot_dir / f"v{n:04d}{suffix}"
            path.write_text(content, encoding="utf-8")
        except OSError as e:
            logger.warning(
                "snapshot write failed (n=%d, dir=%s): %s",
                n,
                self._snapshot_dir,
                e,
            )

    def _reject_directory_code(self) -> None:
        """v1 supports file-based artifacts of either type
        (PROSE markdown, CODE single-file) — both go through the same
        read_text / atomic-rename path. Directory-based CODE
        (git-commit semantics per the design memo) needs its own
        versioning strategy and is deferred to v1.x.
        """
        if (
            self.artifact.type == ArtifactType.CODE
            and self.artifact.path.exists()
            and self.artifact.path.is_dir()
        ):
            raise NotImplementedError(
                "directory-based CODE artifacts are deferred to v1.x; "
                "v1 supports single-file CODE artifacts only"
            )
