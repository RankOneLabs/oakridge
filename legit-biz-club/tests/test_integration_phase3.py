"""End-to-end integration test for Phase 3.

Exercises ``ProjectCoordinator`` + ``MultiRoundConsensus`` +
``JigProposer`` together with stub :class:`LLMClient` instances.
This is the "everything wired through, no real API calls" test that
catches integration drift between the layers.

Per the design memo: real LLM proposers + multi-round consensus +
project-coordinator dispatch is the v1 architecture's full path. This
test validates that path produces a clean :class:`ProjectRunResult`.
"""
from __future__ import annotations

import json
from pathlib import Path

from jig.core.types import CompletionParams, LLMClient, LLMResponse, Usage
from jig.tracing.stdout import StdoutTracer

from legit_biz_club import (
    Agent,
    Artifact,
    ArtifactType,
    Brief,
    CoordinationProtocol,
    Enrollment,
    Mediator,
    MultiRoundConsensus,
    Project,
    ProjectCoordinator,
    ProposalResult,
    StableOrderingByAgentId,
    StringEqualConvergence,
    make_proposers,
)


class _CannedLLM(LLMClient):
    """Returns the same JSON envelope on every call. Identical content
    across all agents lets multi-round converge in round 1."""

    def __init__(self, content: str) -> None:
        # Use json.dumps so the payload is genuinely valid JSON;
        # f-string + !r would emit single-quoted strings which JSON
        # rejects.
        self._payload = json.dumps(
            {"new_content": content, "rationale": "stubbed"}
        )

    async def complete(self, params: CompletionParams) -> LLMResponse:
        return LLMResponse(
            content=self._payload,
            tool_calls=None,
            usage=Usage(input_tokens=10, output_tokens=20),
            latency_ms=1.0,
            model="stub",
        )


async def test_full_path_multi_round_from_start(tmp_path: Path) -> None:
    """3 agents, all stubbed to return identical content → round 1
    converges, the picked proposal applies, the artifact reflects the
    consensus output."""
    agents = [
        Agent(
            name=f"agent-{i}",
            model=f"claude-sonnet-4-{i}",
            system_prompt=f"You are agent {i}.",
            memory_db_path=tmp_path / f"agent-{i}.db",
        )
        for i in range(3)
    ]
    artifact_path = tmp_path / "draft.md"
    artifact_path.write_text("seed", encoding="utf-8")
    project = Project(
        artifact=Artifact(type=ArtifactType.PROSE, path=artifact_path),
        brief=Brief(
            target_spec="ship a one-paragraph draft",
            success_criteria=["under 100 words"],
        ),
        enrollments=[
            Enrollment(agent_id=a.id, project_id="p-int") for a in agents
        ],
        coordination_protocol=CoordinationProtocol.MULTI_ROUND_FROM_START,
    )

    target_output = "the consensus paragraph"
    overrides = {a.id: _CannedLLM(target_output) for a in agents}
    proposers = make_proposers(agents, llm_overrides=overrides)
    mediator = Mediator(project.artifact, [a.id for a in agents])

    coordinator = ProjectCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        round_budget_policy=StringEqualConvergence(max_rounds=2),
        disagreement_surface=StableOrderingByAgentId(),
        consensus_mechanism_factory=MultiRoundConsensus,
        tracer=StdoutTracer(color=False),
    )
    result = await coordinator.run()

    # Protocol skipped incremental, ran consensus.
    assert result.protocol == CoordinationProtocol.MULTI_ROUND_FROM_START
    assert result.incremental is None
    assert result.consensus is not None
    # Identical stub content → convergence in round 1.
    assert result.consensus.converged_at_round == 1
    # Picked proposal applied successfully.
    assert result.consensus.apply_outcome.result == ProposalResult.APPLIED
    # Disk reflects the consensus pick.
    assert artifact_path.read_text(encoding="utf-8") == target_output
