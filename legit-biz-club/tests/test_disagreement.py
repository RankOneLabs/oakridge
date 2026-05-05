"""Tests for the DisagreementSurface protocol and v1 default."""
from __future__ import annotations

import pytest

from legit_biz_club.coordination.disagreement import (
    PickResult,
    StableOrderingByAgentId,
)
from legit_biz_club.coordination.proposal import Proposal


def _proposal(agent_id: str, content: str) -> Proposal:
    return Proposal(
        agent_id=agent_id,
        based_on_version="v0",
        new_content=content,
    )


async def test_picks_first_by_agent_id_lex_order() -> None:
    surface = StableOrderingByAgentId()
    result = await surface.pick(
        [
            _proposal("zebra", "z content"),
            _proposal("alpha", "a content"),
            _proposal("mango", "m content"),
        ]
    )
    assert isinstance(result, PickResult)
    assert result.proposal.agent_id == "alpha"
    assert result.proposal.new_content == "a content"
    assert "alpha" in result.rationale


async def test_pick_is_deterministic_across_input_order() -> None:
    """Same inputs in different order → same winner."""
    surface = StableOrderingByAgentId()
    inputs = [
        _proposal("b", "b"),
        _proposal("a", "a"),
        _proposal("c", "c"),
    ]
    r1 = await surface.pick(inputs)
    r2 = await surface.pick(list(reversed(inputs)))
    assert r1.proposal.agent_id == r2.proposal.agent_id == "a"


async def test_empty_list_raises() -> None:
    surface = StableOrderingByAgentId()
    with pytest.raises(ValueError):
        await surface.pick([])


async def test_single_proposal_passes_through() -> None:
    surface = StableOrderingByAgentId()
    result = await surface.pick([_proposal("solo", "only one")])
    assert result.proposal.agent_id == "solo"
