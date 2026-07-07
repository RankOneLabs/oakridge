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
    Proposer,
)
from legit_biz_club.coordination.consensus import (
    ConsensusResult,
    ConsensusRoundFailed,
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
    # Multi-round under skip_when: escalation step was skipped, so the
    # apply path went through the converged-round pick.
    assert result.picked_via_escalation is False
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
    # Order at the tail: pick decision, then commit.
    assert kinds[-2:] == ["proposal_picked", "proposal_applied"]


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
    # Escalation actually ran — the surface produced the applied pick.
    assert result.picked_via_escalation is True
    # All agents proposed in both rounds (no skip).
    assert len(result.rounds) == 2
    assert all(not r.converged for r in result.rounds)
    # Stable-ordering picks the alphabetically-first agent id.
    expected_winner = sorted(a.id for a in agents)[0]
    assert result.picked.agent_id == expected_winner
    assert result.apply_outcome.result == ProposalResult.APPLIED

    kinds = [k for k, _ in events]
    assert "escalation_triggered" in kinds
    assert kinds[-2:] == ["proposal_picked", "proposal_applied"]


async def test_consensus_emits_proposal_applied_with_outcome_payload(
    tmp_path: Path,
) -> None:
    """The proposal_applied event mirrors the incremental coordinator's
    payload shape (agent_id / proposal_id / reason / new_version) so a
    kbbl observer can treat both event sources uniformly. Without this
    event, the consensus commit is invisible to a `proposal_applied`-
    only consumer — only the picked decision shows up."""
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
        round_budget_policy=StringEqualConvergence(max_rounds=1),
        disagreement_surface=StableOrderingByAgentId(),
        tracer=StdoutTracer(color=False),
        emit=emit,
    )
    result = await mechanism.execute()

    applied = [(k, p) for k, p in events if k == "proposal_applied"]
    assert len(applied) == 1
    payload = applied[0][1]
    assert payload["agent_id"] == result.picked.agent_id
    assert payload["proposal_id"] == result.picked.id
    # new_version is the post-apply hash — non-None on success.
    assert payload["new_version"] is not None


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


async def test_constructor_rejects_duplicate_agents(tmp_path: Path) -> None:
    """A duplicated agent in the agents list would collapse under
    set(...) and silently bias round participation. Catch it loud."""
    agents = _make_agents(tmp_path, 2)
    duped = [agents[0], agents[0], agents[1]]  # agents[0] appears twice
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _IdenticalProposer] = {
        a.id: _IdenticalProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    with pytest.raises(ValueError, match="agents must contain unique"):
        MultiRoundConsensus(
            project=project,
            agents=duped,
            proposers=proposers,
            mediator=mediator,
            round_budget_policy=StringEqualConvergence(),
            disagreement_surface=StableOrderingByAgentId(),
            tracer=StdoutTracer(color=False),
        )


async def test_constructor_rejects_duplicate_enrollments(
    tmp_path: Path,
) -> None:
    """Same defense for the enrollments side: a duplicated
    Enrollment.agent_id would slip past the original set comparison."""
    agents = _make_agents(tmp_path, 2)
    artifact_path = tmp_path / "draft.md"
    artifact_path.write_text("seed", encoding="utf-8")
    project = Project(
        artifact=Artifact(type=ArtifactType.PROSE, path=artifact_path),
        brief=Brief(target_spec="x", success_criteria=["y"]),
        enrollments=[
            Enrollment(agent_id=agents[0].id, project_id="p"),
            Enrollment(agent_id=agents[0].id, project_id="p"),  # dupe
            Enrollment(agent_id=agents[1].id, project_id="p"),
        ],
    )
    proposers: dict[str, _IdenticalProposer] = {
        a.id: _IdenticalProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    with pytest.raises(
        ValueError, match="project.enrollments must contain unique"
    ):
        MultiRoundConsensus(
            project=project,
            agents=agents,
            proposers=proposers,
            mediator=mediator,
            round_budget_policy=StringEqualConvergence(),
            disagreement_surface=StableOrderingByAgentId(),
            tracer=StdoutTracer(color=False),
        )


async def test_peer_proposals_exclude_self_in_rounds_2_plus(
    tmp_path: Path,
) -> None:
    """Each agent's prior proposal must not be passed back to itself
    as 'peer' context — peers means other agents."""

    captured_peer_ids_by_agent: dict[str, list[list[str]]] = {}

    class _RecordingProposer:
        """Records the peer_proposal agent_ids it was given on each call."""

        def __init__(self) -> None:
            self.calls: list[list[str] | None] = []

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
            ids = (
                None
                if peer_proposals is None
                else [p.agent_id for p in peer_proposals]
            )
            captured_peer_ids_by_agent.setdefault(agent.id, []).append(
                ids if ids is not None else []
            )
            return Proposal(
                agent_id=agent.id,
                based_on_version=current_version,
                new_content=f"r1-{agent.id}",  # unique per agent so no convergence
            )

    agents = _make_agents(tmp_path, 3)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _RecordingProposer] = {
        a.id: _RecordingProposer() for a in agents
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
    )
    await mechanism.execute()

    # Round 1 (call index 0) every agent saw peer_proposals=None.
    for agent in agents:
        assert captured_peer_ids_by_agent[agent.id][0] == []

    # Round 2 (call index 1) every agent saw the OTHER 2 agents' ids,
    # never its own.
    other_ids_by_agent = {
        a.id: sorted(o.id for o in agents if o.id != a.id) for a in agents
    }
    for agent in agents:
        round_2_peers = sorted(captured_peer_ids_by_agent[agent.id][1])
        assert round_2_peers == other_ids_by_agent[agent.id]
        assert agent.id not in round_2_peers


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


async def test_singleround_uses_surface_even_when_round_converges(
    tmp_path: Path,
) -> None:
    """SingleRoundConsensus's escalate is always_runs=True, so the
    DisagreementSurface must be authoritative even if round 1 happens
    to converge. The apply step prefers ``ctx["escalate"]`` over the
    converged-round-pick path for exactly this reason."""

    class _CountingPicker:
        """Wraps StableOrderingByAgentId to verify the surface ran."""

        def __init__(self) -> None:
            self.calls = 0
            self._inner = StableOrderingByAgentId()

        async def pick(self, proposals):  # type: ignore[no-untyped-def]
            self.calls += 1
            return await self._inner.pick(proposals)

    agents = _make_agents(tmp_path, 3)
    project = _make_project(tmp_path, agents)
    # Identical content in round 1 → would converge under multi-round,
    # but single-round must still ask the surface to pick.
    proposers: dict[str, _IdenticalProposer] = {
        a.id: _IdenticalProposer("same content") for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    surface = _CountingPicker()
    mechanism = SingleRoundConsensus(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        round_budget_policy=StringEqualConvergence(max_rounds=1),
        disagreement_surface=surface,  # type: ignore[arg-type]
        tracer=StdoutTracer(color=False),
    )
    result = await mechanism.execute()
    assert surface.calls == 1, (
        "SingleRoundConsensus must consult the DisagreementSurface "
        "even when round 1 converges"
    )
    assert result.apply_outcome.result == ProposalResult.APPLIED
    # Rationale comes from the surface (rather than "converged at round N")
    # confirming the apply step preferred the surface's pick.
    assert "stable-ordering-by-agent-id" in result.rationale
    # Even though round 1 was byte-identical, the authoritative
    # signal is that escalation produced the applied pick.
    assert result.picked_via_escalation is True


async def test_duplicate_enrolled_agent_id_proposer_raises(
    tmp_path: Path,
) -> None:
    """A buggy Proposer that returns another enrolled agent's id (so
    one agent appears twice and another is missing) must surface as a
    programmer error — set-membership-only checks would silently let
    this slip past and skew convergence/picking."""

    class _DupeAgentProposer:
        """Always returns the FIRST agent's id regardless of who's calling."""

        def __init__(self, fixed_agent_id: str) -> None:
            self.fixed = fixed_agent_id

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
                agent_id=self.fixed,
                based_on_version=current_version,
                new_content="x",
            )

    agents = _make_agents(tmp_path, 3)
    project = _make_project(tmp_path, agents)
    # Every proposer returns agent[0].id → duplicates + 2 missing.
    proposers: dict[str, _DupeAgentProposer] = {
        a.id: _DupeAgentProposer(agents[0].id) for a in agents
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
    with pytest.raises(ValueError, match="don't match enrolled agents"):
        await mechanism.execute()


async def test_consensus_preserves_sibling_outputs_when_one_proposer_fails(
    tmp_path: Path,
) -> None:
    """When one proposer raises (e.g. exhausted IO retries), the other
    agents' successful proposals must be preserved in the round outcome
    rather than being discarded. The failed agent's id is recorded in
    RoundOutcome.failed_agents. Consensus degrades with explicit
    per-agent failure, not a total abort."""

    class _FailingProposer:
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
            raise RuntimeError("provider IO failed")

    agents = _make_agents(tmp_path, 3)
    project = _make_project(tmp_path, agents)
    # agents[0] fails; agents[1] and agents[2] succeed
    proposers: dict[str, Proposer] = {
        agents[0].id: _FailingProposer(),
        agents[1].id: _IdenticalProposer("sibling output"),
        agents[2].id: _IdenticalProposer("sibling output"),
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
    result = await mechanism.execute()
    # Mechanism completed despite the failure.
    assert result.apply_outcome.result == ProposalResult.APPLIED
    # The round recorded which agent failed.
    assert len(result.rounds) == 1
    round_outcome = result.rounds[0]
    assert agents[0].id in round_outcome.failed_agents
    # The two successful siblings' proposals are preserved.
    assert len(round_outcome.proposals) == 2
    successful_ids = {p.agent_id for p in round_outcome.proposals}
    assert agents[1].id in successful_ids
    assert agents[2].id in successful_ids


async def test_consensus_all_proposers_failed_raises_structured_error(
    tmp_path: Path,
) -> None:
    class _FailingProposer:
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
            raise RuntimeError(f"provider unavailable for {agent.id}")

    agents = _make_agents(tmp_path, 2)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, Proposer] = {
        agent.id: _FailingProposer() for agent in agents
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

    with pytest.raises(ConsensusRoundFailed) as exc_info:
        await mechanism.execute()

    err = exc_info.value
    assert err.round_index == 1
    assert {f.agent_id for f in err.failures} == {a.id for a in agents}
    assert all(f.error_class == "RuntimeError" for f in err.failures)
    assert all("provider unavailable" in f.error_message for f in err.failures)


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
