"""Tests for the round-budget policy."""
from __future__ import annotations

import pytest

from legit_biz_club.coordination.proposal import Proposal
from legit_biz_club.coordination.round_budget import StringEqualConvergence


def _proposal(agent_id: str, content: str) -> Proposal:
    return Proposal(
        agent_id=agent_id,
        based_on_version="v0",
        new_content=content,
    )


def test_max_rounds_default_is_three() -> None:
    policy = StringEqualConvergence()
    assert policy.max_rounds == 3


def test_max_rounds_custom() -> None:
    policy = StringEqualConvergence(max_rounds=7)
    assert policy.max_rounds == 7


def test_rejects_non_positive_max_rounds() -> None:
    with pytest.raises(ValueError):
        StringEqualConvergence(max_rounds=0)
    with pytest.raises(ValueError):
        StringEqualConvergence(max_rounds=-1)


def test_converged_when_all_match() -> None:
    policy = StringEqualConvergence()
    proposals = [
        _proposal("a", "shared content"),
        _proposal("b", "shared content"),
        _proposal("c", "shared content"),
    ]
    assert policy.is_converged(proposals) is True


def test_not_converged_when_one_differs() -> None:
    policy = StringEqualConvergence()
    proposals = [
        _proposal("a", "shared"),
        _proposal("b", "shared"),
        _proposal("c", "different"),
    ]
    assert policy.is_converged(proposals) is False


def test_not_converged_when_only_whitespace_differs() -> None:
    """String equality is byte-strict — even a trailing newline counts
    as divergence. This is intentional: the policy's job is to surface
    the rarely-fires reality of LLM output, not to paper over it."""
    policy = StringEqualConvergence()
    proposals = [
        _proposal("a", "shared"),
        _proposal("b", "shared\n"),
    ]
    assert policy.is_converged(proposals) is False


def test_empty_list_does_not_converge() -> None:
    policy = StringEqualConvergence()
    assert policy.is_converged([]) is False


def test_single_proposal_converges() -> None:
    """Degenerate case — n=1 ensemble has trivially-converged rounds.
    The pipeline rejects n<2 with multi-round at enrollment, so this
    branch is unreachable in practice but the policy returns the
    correct answer if anyone asks."""
    policy = StringEqualConvergence()
    assert policy.is_converged([_proposal("a", "alone")]) is True
