"""Tests for the consensus mechanisms.

Cover both pipelines:

- :class:`MultiRoundConsensus` with proposals that converge in round 1
  (no escalation) and proposals that never converge (escalation via
  the DisagreementSurface).
- :class:`SingleRoundConsensus` — DisagreementSurface always picks.

Plus the constructor validation paths: proposer/agent/enrollment/mediator
agent-id sets must agree, and a buggy Proposer that returns the wrong
agent_id surfaces as a programmer error rather than spinning.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from jig.tracing.stdout import StdoutTracer

from legit_biz_club import (
    Agent,
    Artifact,
    ArtifactType,
    Brief,
    Enrollment,
    Mediator,
    Project,
    Proposal,
    ProposalResult,
)
from legit_biz_club.coordination.consensus import (
    ConsensusResult,
    MultiRoundConsensus,
    SingleRoundConsensus,
)
from legit_biz_club.coordination.disagreement import StableOrderingByAgentId
from legit_biz_club.coordination.round_budget import StringEqualConvergence

# --- helpers --------------------------------------------------------------


def _make_agents(tmp_path: Path, n: int) -> list[Agent]:
    return [
        Agent(
            name=f"agent-{i}",
            model="claude-sonnet-4-5",
            system_prompt=f"you are agent {i}",
            memory_db_path=tmp_path / f"agent-{i}.db",
        )
        for i in range(n)
    ]


def _make_project(tmp_path: Path, agents: list[Agent]) -> Project:
    artifact_path = tmp_path / "draft.md"
    artifact_path.write_text("seed", encoding="utf-8")
    return Project(
        artifact=Artifact(type=ArtifactType.PROSE, path=artifact_path),
        brief=Brief(target_spec="x", success_criteria=["y"]),
        enrollments=[
            Enrollment(agent_id=a.id, project_id="p-test") for a in agents
        ],
    )


class _IdenticalProposer:
    """Returns the same content regardless of agent — round 1 always
    converges under StringEqualConvergence."""

    def __init__(self, content: str = "shared output") -> None:
        self.content = content
        self.calls = 0

    async def propose(
        self,
        *,
        agent: Agent,
        brief: Brief,
        artifact: Artifact,
        current_content: str,
        current_version: str,
        peer_proposals: list[Proposal] | None = None,
    ) -> Proposal:
        self.calls += 1
        return Proposal(
            agent_id=agent.id,
            based_on_version=current_version,
            new_content=self.content,
        )


class _UniquePerAgentProposer:
    """Each agent produces unique content — never converges."""

    async def propose(
        self,
        *,
        agent: Agent,
        brief: Brief,
        artifact: Artifact,
        current_content: str,
        current_version: str,
        peer_proposals: list[Proposal] | None = None,
    ) -> Proposal:
        return Proposal(
            agent_id=agent.id,
            based_on_version=current_version,
            new_content=f"output from {agent.id}",
        )


class _WrongAgentIdProposer:
    """Returns a proposal with a fabricated agent_id."""

    async def propose(
        self,
        *,
        agent: Agent,
        brief: Brief,
        artifact: Artifact,
        current_content: str,
        current_version: str,
        peer_proposals: list[Proposal] | None = None,
    ) -> Proposal:
        return Proposal(
            agent_id="not-enrolled",
            based_on_version=current_version,
            new_content="x",
        )


# --- MultiRoundConsensus --------------------------------------------------


async def test_multiround_converges_at_round_1(tmp_path: Path) -> None:
    """All proposers return identical content → round 1 is convergent;
    later rounds and escalation skip via skip_when."""
    agents = _make_agents(tmp_path, 3)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _IdenticalProposer] = {
        a.id: _IdenticalProposer("the agreed text") for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])

    events: list[tuple[str, dict[str, object]]] = []

    async def emit(kind: str, payload: dict[str, object]) -> None:
        events.append((kind, payload))

    mechanism = MultiRoundConsensus(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        round_budget_policy=StringEqualConvergence(max_rounds=3),
        disagreement_surface=StableOrderingByAgentId(),
        tracer=StdoutTracer(color=False),
        emit=emit,
    )
    result = await mechanism.execute()

    assert isinstance(result, ConsensusResult)
    assert result.converged_at_round == 1
    assert result.picked.new_content == "the agreed text"
    assert result.apply_outcome.result == ProposalResult.APPLIED
    # Each proposer called exactly once (round 1 only).
    assert all(p.calls == 1 for p in proposers.values())
    # Disk reflects the picked proposal.
    assert (
        project.artifact.path.read_text(encoding="utf-8") == "the agreed text"
    )
    # Workspace events.
    kinds = [k for k, _ in events]
    assert kinds[0] == "convergence_started"
    assert "round_completed" in kinds
    assert "escalation_triggered" not in kinds
    assert kinds[-1] == "proposal_picked"


async def test_multiround_escalates_when_no_convergence(
    tmp_path: Path,
) -> None:
    """Each agent's proposal is unique → no round converges → escalation
    fires and DisagreementSurface picks."""
    agents = _make_agents(tmp_path, 3)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _UniquePerAgentProposer] = {
        a.id: _UniquePerAgentProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])

    events: list[tuple[str, dict[str, object]]] = []

    async def emit(kind: str, payload: dict[str, object]) -> None:
        events.append((kind, payload))

    mechanism = MultiRoundConsensus(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        round_budget_policy=StringEqualConvergence(max_rounds=2),
        disagreement_surface=StableOrderingByAgentId(),
        tracer=StdoutTracer(color=False),
        emit=emit,
    )
    result = await mechanism.execute()

    assert result.converged_at_round is None
    # All agents proposed in both rounds (no skip).
    assert len(result.rounds) == 2
    assert all(not r.converged for r in result.rounds)
    # Stable-ordering picks the alphabetically-first agent id.
    expected_winner = sorted(a.id for a in agents)[0]
    assert result.picked.agent_id == expected_winner
    assert result.apply_outcome.result == ProposalResult.APPLIED

    kinds = [k for k, _ in events]
    assert "escalation_triggered" in kinds
    assert kinds[-1] == "proposal_picked"


# --- SingleRoundConsensus -------------------------------------------------


async def test_singleround_always_picks(tmp_path: Path) -> None:
    """One round + DisagreementSurface — the surface always picks even
    if the proposals happen to match."""
    agents = _make_agents(tmp_path, 3)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _UniquePerAgentProposer] = {
        a.id: _UniquePerAgentProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    mechanism = SingleRoundConsensus(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        round_budget_policy=StringEqualConvergence(max_rounds=1),
        disagreement_surface=StableOrderingByAgentId(),
        tracer=StdoutTracer(color=False),
    )
    result = await mechanism.execute()

    # Convergence may or may not be flagged on round 1 (depends on
    # input), but escalation always fires regardless.
    assert len(result.rounds) == 1
    assert result.picked.agent_id == sorted(a.id for a in agents)[0]
    assert result.apply_outcome.result == ProposalResult.APPLIED


# --- constructor validation ------------------------------------------------


async def test_constructor_validates_proposer_keys(tmp_path: Path) -> None:
    agents = _make_agents(tmp_path, 2)
    project = _make_project(tmp_path, agents)
    mediator = Mediator(project.artifact, [a.id for a in agents])
    with pytest.raises(ValueError, match="proposers must be keyed"):
        MultiRoundConsensus(
            project=project,
            agents=agents,
            proposers={"wrong-id": _IdenticalProposer()},
            mediator=mediator,
            round_budget_policy=StringEqualConvergence(),
            disagreement_surface=StableOrderingByAgentId(),
            tracer=StdoutTracer(color=False),
        )


async def test_constructor_validates_enrollments_match(tmp_path: Path) -> None:
    agents = _make_agents(tmp_path, 3)
    project = _make_project(tmp_path, agents)
    # Pass only 2 of the 3 enrolled agents.
    subset = agents[:2]
    proposers: dict[str, _IdenticalProposer] = {
        a.id: _IdenticalProposer() for a in subset
    }
    mediator = Mediator(project.artifact, [a.id for a in subset])
    with pytest.raises(ValueError, match="enrollments"):
        MultiRoundConsensus(
            project=project,
            agents=subset,
            proposers=proposers,
            mediator=mediator,
            round_budget_policy=StringEqualConvergence(),
            disagreement_surface=StableOrderingByAgentId(),
            tracer=StdoutTracer(color=False),
        )


async def test_constructor_validates_mediator_match(tmp_path: Path) -> None:
    agents = _make_agents(tmp_path, 2)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _IdenticalProposer] = {
        a.id: _IdenticalProposer() for a in agents
    }
    # Mediator missing one of the enrolled agents.
    mediator = Mediator(project.artifact, [agents[0].id])
    with pytest.raises(ValueError, match="mediator"):
        MultiRoundConsensus(
            project=project,
            agents=agents,
            proposers=proposers,
            mediator=mediator,
            round_budget_policy=StringEqualConvergence(),
            disagreement_surface=StableOrderingByAgentId(),
            tracer=StdoutTracer(color=False),
        )


# --- proposer programmer-error path ---------------------------------------


async def test_wrong_agent_id_proposer_raises(tmp_path: Path) -> None:
    """A buggy Proposer returning a fabricated agent_id surfaces as a
    programmer error — consensus has no retry semantics, so spinning
    on REJECTED_VALIDATION isn't an option."""
    agents = _make_agents(tmp_path, 2)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _WrongAgentIdProposer] = {
        a.id: _WrongAgentIdProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    mechanism = MultiRoundConsensus(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        round_budget_policy=StringEqualConvergence(max_rounds=1),
        disagreement_surface=StableOrderingByAgentId(),
        tracer=StdoutTracer(color=False),
    )
    with pytest.raises(ValueError, match="programmer error"):
        await mechanism.execute()


async def test_emit_failures_do_not_abort_consensus(tmp_path: Path) -> None:
    """Same safe-emit pattern as the incremental coordinator — a flaky
    HTTP emit shouldn't kill a consensus run."""

    async def flaky(_kind: str, _payload: dict[str, object]) -> None:
        raise RuntimeError("simulated kbbl outage")

    agents = _make_agents(tmp_path, 2)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _IdenticalProposer] = {
        a.id: _IdenticalProposer("agreed") for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    mechanism = MultiRoundConsensus(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        round_budget_policy=StringEqualConvergence(max_rounds=2),
        disagreement_surface=StableOrderingByAgentId(),
        tracer=StdoutTracer(color=False),
        emit=flaky,
    )
    result = await mechanism.execute()
    # Still produces a clean result despite every emit raising.
    assert result.apply_outcome.result == ProposalResult.APPLIED
