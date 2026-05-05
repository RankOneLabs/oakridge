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

from legit_biz_club.coordination.proposal import (
    Proposal,
    ProposalOutcome,
    ProposalResult,
)
from legit_biz_club.coordination.version import compute_version
from legit_biz_club.core.models import Artifact, ArtifactType


class Mediator:
    """Coordinates proposals against a single artifact for one project."""

    def __init__(
        self,
        artifact: Artifact,
        agent_ids: list[str],
        *,
        retry_budget: int = 3,
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

    @property
    def commit_counts(self) -> dict[str, int]:
        """Snapshot of per-agent commit counts."""
        return dict(self._commit_counts)

    @property
    def retry_remaining(self) -> dict[str, int]:
        """Snapshot of per-agent retry budget remaining."""
        return dict(self._retry_remaining)

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
            return ProposalOutcome(
                proposal=proposal,
                result=ProposalResult.APPLIED,
                new_version=new_version,
            )

    def _read_content(self) -> str:
        if self.artifact.type != ArtifactType.PROSE:
            raise NotImplementedError(
                "v1 incremental mode supports PROSE artifacts only"
            )
        return self.artifact.path.read_text(encoding="utf-8")

    def _write_content(self, content: str) -> None:
        if self.artifact.type != ArtifactType.PROSE:
            raise NotImplementedError(
                "v1 incremental mode supports PROSE artifacts only"
            )
        # Atomic-ish: write to a sibling tmpfile then rename. POSIX
        # rename is atomic on the same filesystem; a mid-write crash
        # leaves the previous version intact rather than truncated.
        tmp = self.artifact.path.with_suffix(
            self.artifact.path.suffix + ".tmp"
        )
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(self.artifact.path)
