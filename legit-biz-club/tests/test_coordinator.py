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
