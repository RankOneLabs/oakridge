"""Integration tests for the IncrementalCoordinator.

Drive a realistic round-robin loop with deterministic Proposers so the
test exercises the full apply + termination + emit flow without LLMs.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from legit_biz_club import (
    Agent,
    Artifact,
    ArtifactType,
    Brief,
    Enrollment,
    IncrementalCoordinator,
    KCommitsOrStable,
    KCommitsPerAgent,
    Mediator,
    Project,
    Proposal,
    ProposalResult,
)


class _CountingProposer:
    """Returns deterministic content based on an internal counter."""

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
    artifact = Artifact(type=ArtifactType.PROSE, path=artifact_path)
    brief = Brief(target_spec="ship a draft", success_criteria=["it ships"])
    return Project(
        artifact=artifact,
        brief=brief,
        enrollments=[
            Enrollment(agent_id=a.id, project_id="p-test") for a in agents
        ],
    )


async def test_full_loop_terminates_via_policy(tmp_path: Path) -> None:
    agents = _make_agents(tmp_path, 3)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _CountingProposer] = {
        a.id: _CountingProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents], retry_budget=3)
    policy = KCommitsPerAgent(k=2)

    events: list[tuple[str, dict[str, object]]] = []

    async def emit(kind: str, payload: dict[str, object]) -> None:
        events.append((kind, payload))

    coordinator = IncrementalCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        termination_policy=policy,
        emit=emit,
    )
    result = await coordinator.run()

    # Each agent commits exactly k=2 times since the deterministic
    # proposer + round-robin schedule never produces an OCC conflict.
    assert result.terminated_by == "policy"
    assert all(c == 2 for c in result.final_commit_counts.values())
    assert all(v == 3 for v in result.final_retry_remaining.values())
    # 3 agents × 2 commits = 6 outcomes, all APPLIED.
    assert len(result.outcomes) == 6
    assert all(o.result == ProposalResult.APPLIED for o in result.outcomes)

    kinds = [k for k, _ in events]
    assert kinds[0] == "incremental_started"
    assert kinds[-1] == "incremental_terminated"
    assert kinds.count("proposal_applied") == 6
    # Final disk state shows all 6 commits stacked on the seed.
    final = project.artifact.path.read_text(encoding="utf-8")
    for agent in agents:
        assert agent.name in final


class _StableProposer:
    """Returns the same content regardless of agent or current state —
    every commit produces a byte-identical artifact, so KCommitsOrStable's
    stability check fires after stable_n+1 applies."""

    def __init__(self, content: str = "the agreed text") -> None:
        self.calls = 0
        self._content = content

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
            new_content=self._content,
        )


async def test_stability_check_runs_at_round_boundary_only(
    tmp_path: Path,
) -> None:
    """KCommitsOrStable's stability signal must not fire mid-round —
    otherwise the loop stops as soon as stable_n+1 consecutive
    identical commits land, skipping later agents in that round and
    making commit_counts agent-order-dependent. With n=4 stable
    proposers and stable_n=2, the policy needs 3 identical commits.
    Mid-round stability would terminate after agent 3 leaving agent 4
    with 0 commits in round 1; the round-boundary fix ensures all 4
    agents finish round 1 (commit_counts == 1 each) before the
    round-top check fires for round 2."""
    agents = _make_agents(tmp_path, 4)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _StableProposer] = {
        a.id: _StableProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    policy = KCommitsOrStable(k=99, stable_n=2)  # k high, only stability fires

    coordinator = IncrementalCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        termination_policy=policy,
    )
    result = await coordinator.run()

    # Every agent should have proposed exactly once — round 1
    # completes for all 4, round 2 doesn't start because the
    # round-top stability check fires.
    assert all(c == 1 for c in result.final_commit_counts.values())
    assert result.terminated_by == "policy"
    # Exactly 4 outcomes (one per agent), all APPLIED.
    assert len(result.outcomes) == 4


async def test_constructor_validates_proposer_keys(tmp_path: Path) -> None:
    agents = _make_agents(tmp_path, 2)
    project = _make_project(tmp_path, agents)
    mediator = Mediator(project.artifact, [a.id for a in agents])
    # Mismatched proposer keys should raise.
    with pytest.raises(ValueError):
        IncrementalCoordinator(
            project=project,
            agents=agents,
            proposers={"wrong-id": _CountingProposer()},
            mediator=mediator,
            termination_policy=KCommitsPerAgent(k=1),
        )


async def test_constructor_validates_agents_match_enrollments(
    tmp_path: Path,
) -> None:
    """Subset of enrollments would let KCommitsPerAgent terminate early."""
    agents = _make_agents(tmp_path, 3)
    project = _make_project(tmp_path, agents)
    # Coordinator gets only 2 of the 3 enrolled agents — would terminate
    # after the subset hits K, violating the "every enrolled agent" contract.
    subset_agents = agents[:2]
    proposers: dict[str, _CountingProposer] = {
        a.id: _CountingProposer() for a in subset_agents
    }
    mediator = Mediator(project.artifact, [a.id for a in subset_agents])
    with pytest.raises(ValueError, match="must match project.enrollments"):
        IncrementalCoordinator(
            project=project,
            agents=subset_agents,
            proposers=proposers,
            mediator=mediator,
            termination_policy=KCommitsPerAgent(k=1),
        )


async def test_constructor_validates_mediator_agents(tmp_path: Path) -> None:
    """If the Mediator is missing an enrolled agent, _agent_exhausted
    treats the agent as already-done (retry_remaining.get returns 0).
    The run could terminate via all_exhausted without ever giving the
    missing agent a turn — fail loud at construction time."""
    agents = _make_agents(tmp_path, 2)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _CountingProposer] = {
        a.id: _CountingProposer() for a in agents
    }
    # Mediator only knows about the first agent.
    mediator = Mediator(project.artifact, [agents[0].id])
    with pytest.raises(ValueError, match="mediator must be initialized"):
        IncrementalCoordinator(
            project=project,
            agents=agents,
            proposers=proposers,
            mediator=mediator,
            termination_policy=KCommitsPerAgent(k=1),
        )


async def test_emit_failures_do_not_abort_loop(tmp_path: Path) -> None:
    """Production emit is wired to an HTTP call; a transient kbbl outage
    must not stop a coordination run mid-flight after the proposal
    already mediated successfully."""

    async def flaky_emit(_kind: str, _payload: dict[str, object]) -> None:
        raise RuntimeError("simulated kbbl outage")

    agents = _make_agents(tmp_path, 2)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _CountingProposer] = {
        a.id: _CountingProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents], retry_budget=3)
    coordinator = IncrementalCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        termination_policy=KCommitsPerAgent(k=2),
        emit=flaky_emit,
    )
    # Loop completes despite every emit raising — all 4 commits land.
    result = await coordinator.run()
    assert result.terminated_by == "policy"
    assert all(c == 2 for c in result.final_commit_counts.values())


async def test_step_raises_on_wrong_agent_id_proposal(tmp_path: Path) -> None:
    """A buggy Proposer returning the wrong agent_id is a programmer error
    — surface immediately rather than spinning on REJECTED_VALIDATION
    (which doesn't decrement retry budget)."""

    class _WrongAgentIdProposer:
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
                agent_id="not-the-right-id",
                based_on_version=current_version,
                new_content="x",
            )

    agents = _make_agents(tmp_path, 2)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _WrongAgentIdProposer] = {
        a.id: _WrongAgentIdProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents])
    coordinator = IncrementalCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        termination_policy=KCommitsPerAgent(k=1),
    )
    with pytest.raises(ValueError, match="programmer error"):
        await coordinator.run()


async def test_terminated_by_all_exhausted(tmp_path: Path) -> None:
    """A proposer that always returns a stale version drains the retry
    budget; the coordinator should surface ``all_exhausted`` rather than
    looping forever."""

    class _AlwaysStaleProposer:
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
                based_on_version="stale-0000",  # never matches
                new_content="ignored",
            )

    agents = _make_agents(tmp_path, 2)
    project = _make_project(tmp_path, agents)
    proposers: dict[str, _AlwaysStaleProposer] = {
        a.id: _AlwaysStaleProposer() for a in agents
    }
    mediator = Mediator(project.artifact, [a.id for a in agents], retry_budget=2)
    policy = KCommitsPerAgent(k=99)  # never fires by commit count

    coordinator = IncrementalCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        termination_policy=policy,
    )
    result = await coordinator.run()

    assert result.terminated_by == "all_exhausted"
    assert all(c == 0 for c in result.final_commit_counts.values())
    assert all(r == 0 for r in result.final_retry_remaining.values())
    assert all(
        o.result == ProposalResult.REJECTED_OCC for o in result.outcomes
    )
