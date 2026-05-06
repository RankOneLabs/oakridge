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
from legit_biz_club.study.targets import code_target, prose_target


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
    # Multi-round skip_when fires → escalate didn't run → not escalated.
    assert result.metrics.escalation_invoked is False


async def test_run_cell_rejects_artifact_filename_with_separators(
    tmp_path: Path,
) -> None:
    """Directory-shaped artifact_filenames are deferred to v1.x —
    catch both POSIX `/` and Windows `\\` separators via PurePath."""
    target = prose_target(
        artifact_filename="subdir/draft.md",
        seed_content="seed",
    )
    condition = single_agent_baseline()

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    import pytest

    with pytest.raises(ValueError, match="path separators"):
        await run_cell(
            target=target,
            condition=condition,
            proposer_factory=proposer_factory,
            output_dir=tmp_path,
            tracer=StdoutTracer(color=False),
        )


async def test_run_cell_handles_code_target_single_file(
    tmp_path: Path,
) -> None:
    """v1 supports single-file CODE targets — runner builds them the
    same as prose targets, mediator handles the read/write path."""
    target = code_target(seed_content="def stub(): ...\n")
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
    # Cell ran end-to-end; the .py artifact reflects the appended commits.
    assert result.artifact_path.suffix == ".py"
    assert result.final_artifact_content.startswith("def stub(): ...")


async def test_run_cell_uses_consistent_project_id(tmp_path: Path) -> None:
    """Project.id and Enrollment.project_id must match — they refer
    to the same project. The runner uses a stable cell-id string for
    both."""
    target = prose_target(seed_content="seed")
    condition = ensemble_incremental_only(n=2)

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    result = await run_cell(
        target=target,
        condition=condition,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        tracer=StdoutTracer(color=False),
    )
    project = result.run_result.project
    assert project.id == f"{target.name}-{condition.name}"
    for enrollment in project.enrollments:
        assert enrollment.project_id == project.id


async def test_run_cell_singleround_marks_escalation_even_when_converged(
    tmp_path: Path,
) -> None:
    """SingleRoundConsensus's escalate step always runs and is
    authoritative — escalation_invoked must be True even when round 1
    happens to be byte-identical. Inferring from converged_at_round
    alone would undercount escalations and distort cross-condition
    aggregation."""
    target = prose_target(seed_content="seed")
    condition = ensemble_with_single_round(n=3)

    def proposer_factory(_agent: Agent) -> _ConvergingProposer:
        return _ConvergingProposer("identical content")

    result = await run_cell(
        target=target,
        condition=condition,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        tracer=StdoutTracer(color=False),
    )
    # Round 1 may report converged (byte-identical proposals)...
    assert result.metrics.convergence_round_converged == 1
    # ...but the surface still ran and produced the applied pick.
    assert result.metrics.escalation_invoked is True


async def test_run_cell_rejects_reserved_sidecar_filenames(
    tmp_path: Path,
) -> None:
    """Sidecars (commits/, agent_memory/, events.jsonl) live in the
    cell directory next to the artifact. A target whose
    artifact_filename collides with one of them would either crash
    the runner (commits/ rmtree on a file) or silently corrupt the
    artifact (events.jsonl tee from the driver). Validate at
    run_cell entry rather than waiting for the failure mode."""
    import pytest

    condition = single_agent_baseline()

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    for reserved in ("commits", "agent_memory", "events.jsonl"):
        target = prose_target(
            artifact_filename=reserved, seed_content="seed"
        )
        with pytest.raises(ValueError, match="reserved sidecar"):
            await run_cell(
                target=target,
                condition=condition,
                proposer_factory=proposer_factory,
                output_dir=tmp_path / reserved,  # fresh dir per attempt
                tracer=StdoutTracer(color=False),
            )


async def test_run_cell_resets_commits_dir_between_runs(
    tmp_path: Path,
) -> None:
    """commits/ from a prior run must be wiped before the new run —
    Mediator restarts numbering at v0001, so a shorter rerun would
    otherwise leave stale higher-numbered files mixing two runs'
    history into one cell directory."""
    target = prose_target(seed_content="seed")
    condition = single_agent_baseline()

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    # Drop a stale snapshot from a "previous" run before invoking
    # run_cell — it should be gone after.
    cell_dir = tmp_path / target.name / condition.name
    (cell_dir / "commits").mkdir(parents=True)
    (cell_dir / "commits" / "v9999.md").write_text(
        "stale from a previous run", encoding="utf-8"
    )

    await run_cell(
        target=target,
        condition=condition,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        tracer=StdoutTracer(color=False),
    )
    assert not (cell_dir / "commits" / "v9999.md").exists()


async def test_run_cell_uses_termination_policy_factory_when_set(
    tmp_path: Path,
) -> None:
    """ConditionConfig.termination_policy_factory propagates to the
    coordinator. Pass a factory that caps at k=1 commits per agent and
    the cell terminates after n*1 commits regardless of what the
    default policy would have done."""
    from legit_biz_club import KCommitsPerAgent
    from legit_biz_club.core.models import CoordinationProtocol
    from legit_biz_club.study.conditions import ConditionConfig

    target = prose_target(seed_content="seed")
    condition = ConditionConfig(
        name="custom_term",
        n=2,
        coordination_protocol=CoordinationProtocol.INCREMENTAL_ONLY,
        termination_policy_factory=lambda: KCommitsPerAgent(k=1),
    )

    def proposer_factory(_agent: Agent) -> _AppendingProposer:
        return _AppendingProposer()

    result = await run_cell(
        target=target,
        condition=condition,
        proposer_factory=proposer_factory,
        output_dir=tmp_path,
        tracer=StdoutTracer(color=False),
    )
    # k=1 with n=2 → 2 commits attempted/applied (vs default k=5 → 10).
    assert result.metrics.incremental_commits_applied == 2


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
