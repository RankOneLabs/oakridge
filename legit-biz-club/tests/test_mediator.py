"""Tests for the project-layer mediator.

Cover the four ``ProposalResult`` paths plus the OCC retry-budget
accounting and the atomic write-rename invariant.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from legit_biz_club import (
    Artifact,
    ArtifactType,
    Mediator,
    Proposal,
    ProposalResult,
    compute_version,
)


def _prose_artifact(tmp_path: Path, content: str = "initial") -> Artifact:
    p = tmp_path / "draft.md"
    p.write_text(content, encoding="utf-8")
    return Artifact(type=ArtifactType.PROSE, path=p)


@pytest.fixture
def mediator(tmp_path: Path) -> Mediator:
    artifact = _prose_artifact(tmp_path)
    return Mediator(artifact, ["a-1", "a-2", "a-3"], retry_budget=3)


async def test_apply_succeeds_against_current_version(mediator: Mediator) -> None:
    _, version = await mediator.current_state()
    proposal = Proposal(
        agent_id="a-1",
        based_on_version=version,
        new_content="updated",
    )
    outcome = await mediator.apply(proposal)
    assert outcome.result == ProposalResult.APPLIED
    assert outcome.new_version is not None
    assert outcome.new_version != version
    assert mediator.commit_counts["a-1"] == 1
    assert mediator.retry_remaining["a-1"] == 3
    # Disk reflects the new content.
    assert mediator.artifact.path.read_text(encoding="utf-8") == "updated"


async def test_apply_rejects_unknown_agent(mediator: Mediator) -> None:
    _, version = await mediator.current_state()
    proposal = Proposal(
        agent_id="not-enrolled",
        based_on_version=version,
        new_content="x",
    )
    outcome = await mediator.apply(proposal)
    assert outcome.result == ProposalResult.REJECTED_VALIDATION
    # Unknown agents don't get an entry in either dict — explicit assertion.
    assert "not-enrolled" not in mediator.commit_counts
    assert "not-enrolled" not in mediator.retry_remaining


async def test_occ_rejection_charges_retry(mediator: Mediator) -> None:
    _, stale_version = await mediator.current_state()
    # First, apply something else so the version moves.
    other = Proposal(
        agent_id="a-2",
        based_on_version=stale_version,
        new_content="bumped",
    )
    await mediator.apply(other)
    # Now a-1 submits with the stale version — should reject + charge retry.
    stale = Proposal(
        agent_id="a-1",
        based_on_version=stale_version,
        new_content="should not land",
    )
    outcome = await mediator.apply(stale)
    assert outcome.result == ProposalResult.REJECTED_OCC
    assert mediator.commit_counts["a-1"] == 0
    assert mediator.retry_remaining["a-1"] == 2
    # Disk reflects the OTHER agent's apply, not this rejected proposal.
    assert mediator.artifact.path.read_text(encoding="utf-8") == "bumped"


async def test_budget_exhaustion_path(mediator: Mediator) -> None:
    """After three OCC rejections in a row, the next attempt is BUDGET_EXHAUSTED."""
    _, stale_version = await mediator.current_state()
    # Apply something so a-1's stale_version is actually stale.
    await mediator.apply(
        Proposal(
            agent_id="a-2",
            based_on_version=stale_version,
            new_content="moved",
        )
    )
    # Burn a-1's retry budget with stale proposals.
    for _ in range(3):
        await mediator.apply(
            Proposal(
                agent_id="a-1",
                based_on_version=stale_version,
                new_content="x",
            )
        )
    assert mediator.retry_remaining["a-1"] == 0
    # Even a fresh-version proposal now fails with BUDGET_EXHAUSTED.
    _, fresh_version = await mediator.current_state()
    final = Proposal(
        agent_id="a-1",
        based_on_version=fresh_version,
        new_content="too late",
    )
    outcome = await mediator.apply(final)
    assert outcome.result == ProposalResult.BUDGET_EXHAUSTED
    assert mediator.commit_counts["a-1"] == 0


async def test_current_state_returns_consistent_pair(mediator: Mediator) -> None:
    content, version = await mediator.current_state()
    # The version should match what compute_version would yield from the content.
    assert version == compute_version(mediator.artifact, content=content)


def test_mediator_rejects_non_positive_retry_budget(tmp_path: Path) -> None:
    artifact = _prose_artifact(tmp_path)
    with pytest.raises(ValueError):
        Mediator(artifact, ["a-1"], retry_budget=0)
    with pytest.raises(ValueError):
        Mediator(artifact, ["a-1"], retry_budget=-2)
