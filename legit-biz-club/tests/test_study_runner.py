"""Tests for the study runner.

Drives ``run_cell`` and ``run_study`` end-to-end with stub proposers
and a stub grader. Verifies:

- Cell directory layout (output_dir/{target}/{condition}/...).
- Final artifact reflects the project's commits.
- CellMetrics captures incremental + consensus counters.
- Eval scores flow through when a grader_factory is supplied.
- run_study runs every (target, condition) pair and orders results
  consistently.
"""
from __future__ import annotations

from pathlib import Path

from jig.core.types import (
    Grader,
    Score,
    ScoreSource,
)
from jig.tracing.stdout import StdoutTracer

from legit_biz_club.coordination.proposal import Proposal
from legit_biz_club.core.models import Agent, Artifact, Brief
from legit_biz_club.study.conditions import (
    ensemble_incremental_only,
    ensemble_with_multi_round,
    ensemble_with_single_round,
    single_agent_baseline,
)
from legit_biz_club.study.runner import (
    CellMetrics,
    CellResult,
    run_cell,
    run_study,
)
from legit_biz_club.study.targets import prose_target


class _AppendingProposer:
    """Returns content that appends agent-id markers — every commit
    advances the artifact deterministically and incremental
    termination fires by policy without hitting OCC retries."""

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


class _ConvergingProposer:
    """Returns the same content regardless of agent — every consensus
    round converges in round 1."""

    def __init__(self, content: str) -> None:
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


class _FixedScoreGrader(Grader):
    """Returns the same scores on every grade() call."""

    def __init__(self, dimensions: list[str]) -> None:
        self._dimensions = dimensions

    async def grade(
        self,
        input: str,  # noqa: A002 — Grader protocol
        output: str,
        context: dict[str, object] | None = None,
    ) -> list[Score]:
        return [
            Score(dimension=d, value=0.7, source=ScoreSource.LLM_JUDGE)
            for d in self._dimensions
        ]


# --- run_cell --------------------------------------------------------------


async def test_run_cell_writes_artifact_to_cell_dir(tmp_path: Path) -> None:
    target = prose_target(seed_content="seed")
    condition = single_agent_baseline()

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    result = await run_cell(
        target=target,
        condition=condition,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        tracer=StdoutTracer(color=False),
    )
    assert isinstance(result, CellResult)
    expected_dir = tmp_path / target.name / condition.name
    assert result.artifact_path.parent == expected_dir
    assert result.artifact_path.exists()
    # Final content reflects the commits applied.
    assert result.final_artifact_content.startswith("seed")
    assert "agent" in result.final_artifact_content


async def test_run_cell_metrics_capture_incremental_counters(
    tmp_path: Path,
) -> None:
    target = prose_target(seed_content="seed")
    condition = ensemble_incremental_only(n=3)

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    result = await run_cell(
        target=target,
        condition=condition,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        tracer=StdoutTracer(color=False),
    )
    assert isinstance(result.metrics, CellMetrics)
    # Default termination policy (KCommitsPerAgent k=5) fires after
    # n*5 commits; every commit applies cleanly with the appending
    # proposer, so attempted == applied == 15.
    assert result.metrics.incremental_commits_attempted == 15
    assert result.metrics.incremental_commits_applied == 15
    # No consensus phase under INCREMENTAL_ONLY.
    assert result.metrics.convergence_rounds_run == 0
    assert result.metrics.convergence_round_converged is None
    assert result.metrics.escalation_invoked is False


async def test_run_cell_with_consensus_records_convergence(
    tmp_path: Path,
) -> None:
    target = prose_target(seed_content="seed")
    condition = ensemble_with_multi_round(n=3)

    def proposer_factory(_agent: Agent) -> _ConvergingProposer:
        return _ConvergingProposer("the agreed text")

    result = await run_cell(
        target=target,
        condition=condition,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        tracer=StdoutTracer(color=False),
    )
    # Consensus phase ran and converged in round 1.
    assert result.metrics.convergence_rounds_run >= 1
    assert result.metrics.convergence_round_converged == 1
    assert result.metrics.escalation_invoked is False


async def test_run_cell_runs_grader_when_factory_supplied(
    tmp_path: Path,
) -> None:
    target = prose_target(seed_content="seed")
    condition = single_agent_baseline()

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    def grader_factory(t):  # type: ignore[no-untyped-def]
        return _FixedScoreGrader([c for c in t.brief.success_criteria])

    result = await run_cell(
        target=target,
        condition=condition,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        grader_factory=grader_factory,
        tracer=StdoutTracer(color=False),
    )
    assert len(result.eval_scores) == len(target.brief.success_criteria)
    assert all(s.value == 0.7 for s in result.eval_scores)


async def test_run_cell_with_no_grader_factory_yields_empty_scores(
    tmp_path: Path,
) -> None:
    target = prose_target(seed_content="seed")
    condition = single_agent_baseline()

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    result = await run_cell(
        target=target,
        condition=condition,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        tracer=StdoutTracer(color=False),
    )
    assert result.eval_scores == []


# --- run_study -------------------------------------------------------------


async def test_run_study_runs_every_target_condition_pair(
    tmp_path: Path,
) -> None:
    targets = [prose_target(seed_content="prose-seed")]
    conditions = [
        single_agent_baseline(),
        ensemble_incremental_only(n=2),
        ensemble_with_single_round(n=2),
    ]

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    results = await run_study(
        targets=targets,
        conditions=conditions,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        tracer=StdoutTracer(color=False),
    )
    assert len(results) == len(targets) * len(conditions)
    # Order is (target outer, condition inner).
    assert [r.condition_name for r in results] == [c.name for c in conditions]


async def test_run_study_isolates_cells_via_subdirectories(
    tmp_path: Path,
) -> None:
    """Two cells writing to artifact files of the same name don't
    collide because each cell gets its own subdirectory."""
    target = prose_target(seed_content="seed", artifact_filename="draft.md")
    conditions = [
        single_agent_baseline(),
        ensemble_incremental_only(n=2),
    ]

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    results = await run_study(
        targets=[target],
        conditions=conditions,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        tracer=StdoutTracer(color=False),
    )
    paths = [r.artifact_path for r in results]
    assert len(paths) == 2
    # Same filename, different parent directories.
    assert paths[0].name == paths[1].name
    assert paths[0].parent != paths[1].parent
