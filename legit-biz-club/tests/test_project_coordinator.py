"""Integration tests for the ProjectCoordinator dispatch.

Cover all three coordination protocols end-to-end with stub Proposers:

- INCREMENTAL_ONLY: only the incremental phase runs.
- INCREMENTAL_THEN_CONVERGE: incremental runs, then consensus runs;
  retry budgets reset between phases so a budget-exhausted agent
  can still land a picked proposal.
- MULTI_ROUND_FROM_START: only consensus runs, no incremental.
"""
from __future__ import annotations

from pathlib import Path

from jig.tracing.stdout import StdoutTracer

from legit_biz_club import (
    Agent,
    Artifact,
    ArtifactType,
    Brief,
    CoordinationProtocol,
    Enrollment,
    KCommitsPerAgent,
    Mediator,
    Project,
    ProjectState,
    Proposal,
    transition_to,
)
from legit_biz_club.coordination.disagreement import StableOrderingByAgentId
from legit_biz_club.coordination.project_coordinator import (
    ProjectCoordinator,
    ProjectRunResult,
)
from legit_biz_club.coordination.round_budget import StringEqualConvergence


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


def _make_project(
    tmp_path: Path,
    agents: list[Agent],
    protocol: CoordinationProtocol = CoordinationProtocol.INCREMENTAL_ONLY,
) -> Project:
    tmp_path.mkdir(parents=True, exist_ok=True)
    artifact_path = tmp_path / "draft.md"
    artifact_path.write_text("seed", encoding="utf-8")
    project = Project(
        artifact=Artifact(type=ArtifactType.PROSE, path=artifact_path),
        brief=Brief(target_spec="x", success_criteria=["y"]),
        enrollments=[
            Enrollment(agent_id=a.id, project_id="p-test") for a in agents
        ],
        coordination_protocol=protocol,
    )
    # ProjectCoordinator.run requires ENROLLING state.
    project.state = transition_to(project.state, ProjectState.ENROLLING)
    return project


class _IdenticalProposer:
    def __init__(self, content: str = "shared text") -> None:
        self.content = content

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
            new_content=self.content,
        )


class _CountingProposer:
    """Generates unique content per call so the incremental phase can
    actually commit (matching tokens would otherwise look stuck)."""

    def __init__(self) -> None:
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
            new_content=f"{current_content}\n[{agent.name} #{self.calls}]",
        )


# --- INCREMENTAL_ONLY ----------------------------------------------------


async def test_incremental_only_protocol(tmp_path: Path) -> None:
    agents = _make_agents(tmp_path, 2)
    project = _make_project(
        tmp_path, agents, CoordinationProtocol.INCREMENTAL_ONLY
    )
    proposers: dict[str, _CountingProposer] = {
        a.id: _CountingProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    coordinator = ProjectCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        termination_policy=KCommitsPerAgent(k=2),
        tracer=StdoutTracer(color=False),
    )
    result = await coordinator.run()
    assert isinstance(result, ProjectRunResult)
    assert result.protocol == CoordinationProtocol.INCREMENTAL_ONLY
    assert result.incremental is not None
    assert result.consensus is None
    assert result.incremental.terminated_by == "policy"


# --- MULTI_ROUND_FROM_START ----------------------------------------------


async def test_multi_round_from_start_protocol(tmp_path: Path) -> None:
    agents = _make_agents(tmp_path, 3)
    project = _make_project(
        tmp_path, agents, CoordinationProtocol.MULTI_ROUND_FROM_START
    )
    proposers: dict[str, _IdenticalProposer] = {
        a.id: _IdenticalProposer("the agreed text") for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    coordinator = ProjectCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        round_budget_policy=StringEqualConvergence(max_rounds=2),
        disagreement_surface=StableOrderingByAgentId(),
        tracer=StdoutTracer(color=False),
    )
    result = await coordinator.run()
    assert result.protocol == CoordinationProtocol.MULTI_ROUND_FROM_START
    assert result.incremental is None
    assert result.consensus is not None
    assert result.consensus.converged_at_round == 1
    # Disk reflects the consensus pick.
    assert (
        project.artifact.path.read_text(encoding="utf-8") == "the agreed text"
    )


# --- INCREMENTAL_THEN_CONVERGE -------------------------------------------


async def test_incremental_then_converge_protocol(tmp_path: Path) -> None:
    """Incremental runs to termination, retry budgets reset, then
    consensus runs and produces a final unified state."""
    agents = _make_agents(tmp_path, 2)
    project = _make_project(
        tmp_path, agents, CoordinationProtocol.INCREMENTAL_THEN_CONVERGE
    )
    # IdenticalProposer in both phases: incremental terminates by
    # policy (mediator counts each apply regardless of identical
    # content), then consensus converges quickly on the same content.
    proposers: dict[str, _IdenticalProposer] = {
        a.id: _IdenticalProposer("shared") for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    coordinator = ProjectCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        termination_policy=KCommitsPerAgent(k=1),
        round_budget_policy=StringEqualConvergence(max_rounds=2),
        disagreement_surface=StableOrderingByAgentId(),
        tracer=StdoutTracer(color=False),
    )
    result = await coordinator.run()
    assert result.protocol == CoordinationProtocol.INCREMENTAL_THEN_CONVERGE
    assert result.incremental is not None
    assert result.consensus is not None
    # Incremental terminated via policy (each agent hit K=1).
    assert result.incremental.terminated_by == "policy"
    # Consensus picked successfully.
    assert result.consensus.apply_outcome.result.value == "applied"


# --- protocol field is the single source of truth -------------------------


async def test_protocol_field_drives_dispatch(tmp_path: Path) -> None:
    """Same agents/mediator, different protocol → different result shape."""
    agents = _make_agents(tmp_path, 2)
    proposers: dict[str, _IdenticalProposer] = {
        a.id: _IdenticalProposer("x") for a in agents
    }

    # INCREMENTAL_ONLY → consensus is None.
    project_inc = _make_project(
        tmp_path / "a", agents, CoordinationProtocol.INCREMENTAL_ONLY
    )
    mediator_inc = Mediator(project_inc.artifact, [a.id for a in agents])
    result_inc = await ProjectCoordinator(
        project=project_inc,
        agents=agents,
        proposers=proposers,
        mediator=mediator_inc,
        termination_policy=KCommitsPerAgent(k=1),
        tracer=StdoutTracer(color=False),
    ).run()
    assert result_inc.consensus is None

    # MULTI_ROUND_FROM_START → incremental is None.
    project_mr = _make_project(
        tmp_path / "b", agents, CoordinationProtocol.MULTI_ROUND_FROM_START
    )
    mediator_mr = Mediator(project_mr.artifact, [a.id for a in agents])
    result_mr = await ProjectCoordinator(
        project=project_mr,
        agents=agents,
        proposers=proposers,
        mediator=mediator_mr,
        round_budget_policy=StringEqualConvergence(max_rounds=1),
        disagreement_surface=StableOrderingByAgentId(),
        tracer=StdoutTracer(color=False),
    ).run()
    assert result_mr.incremental is None
