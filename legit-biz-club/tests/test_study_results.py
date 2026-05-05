"""Tests for study result aggregation."""
from __future__ import annotations

from pathlib import Path

from jig.core.types import Score, ScoreSource

from legit_biz_club.coordination.project_coordinator import ProjectRunResult
from legit_biz_club.core.models import (
    Artifact,
    ArtifactType,
    Brief,
    CoordinationProtocol,
    Project,
)
from legit_biz_club.study.results import (
    ConditionSummary,
    StudyResult,
    aggregate,
)
from legit_biz_club.study.runner import CellMetrics, CellResult


def _cell(
    *,
    condition_name: str,
    target_name: str = "prose_blog_post",
    eval_scores: list[Score] | None = None,
    metrics: CellMetrics | None = None,
    tmp_path: Path | None = None,
) -> CellResult:
    artifact_path = (tmp_path or Path("/tmp")) / "draft.md"
    project = Project(
        artifact=Artifact(type=ArtifactType.PROSE, path=artifact_path),
        brief=Brief(target_spec="x", success_criteria=["a"]),
    )
    return CellResult(
        target_name=target_name,
        condition_name=condition_name,
        artifact_path=artifact_path,
        final_artifact_content="content",
        run_result=ProjectRunResult(
            project=project,
            protocol=CoordinationProtocol.INCREMENTAL_ONLY,
            incremental=None,
            consensus=None,
        ),
        metrics=metrics
        or CellMetrics(
            incremental_commits_attempted=5,
            incremental_commits_applied=5,
            convergence_rounds_run=0,
            convergence_round_converged=None,
            escalation_invoked=False,
        ),
        eval_scores=eval_scores or [],
    )


def test_aggregate_groups_cells_by_condition(tmp_path: Path) -> None:
    cells = [
        _cell(condition_name="cond_a", tmp_path=tmp_path),
        _cell(condition_name="cond_a", tmp_path=tmp_path),
        _cell(condition_name="cond_b", tmp_path=tmp_path),
    ]
    result = aggregate(cells)
    assert isinstance(result, StudyResult)
    assert set(result.by_condition.keys()) == {"cond_a", "cond_b"}
    assert result.by_condition["cond_a"].n_cells == 2
    assert result.by_condition["cond_b"].n_cells == 1


def test_aggregate_averages_scores_per_dimension(tmp_path: Path) -> None:
    cells = [
        _cell(
            condition_name="c",
            eval_scores=[
                Score(dimension="clarity", value=0.8, source=ScoreSource.LLM_JUDGE),
                Score(dimension="rigor", value=0.6, source=ScoreSource.LLM_JUDGE),
            ],
            tmp_path=tmp_path,
        ),
        _cell(
            condition_name="c",
            eval_scores=[
                Score(dimension="clarity", value=0.4, source=ScoreSource.LLM_JUDGE),
                Score(dimension="rigor", value=1.0, source=ScoreSource.LLM_JUDGE),
            ],
            tmp_path=tmp_path,
        ),
    ]
    result = aggregate(cells)
    summary = result.by_condition["c"]
    assert abs(summary.avg_scores_by_dimension["clarity"] - 0.6) < 1e-9
    assert abs(summary.avg_scores_by_dimension["rigor"] - 0.8) < 1e-9


def test_aggregate_averages_apply_counts(tmp_path: Path) -> None:
    cells = [
        _cell(
            condition_name="c",
            metrics=CellMetrics(
                incremental_commits_attempted=10,
                incremental_commits_applied=10,
                convergence_rounds_run=0,
                convergence_round_converged=None,
                escalation_invoked=False,
            ),
            tmp_path=tmp_path,
        ),
        _cell(
            condition_name="c",
            metrics=CellMetrics(
                incremental_commits_attempted=5,
                incremental_commits_applied=4,
                convergence_rounds_run=0,
                convergence_round_converged=None,
                escalation_invoked=False,
            ),
            tmp_path=tmp_path,
        ),
    ]
    result = aggregate(cells)
    assert result.by_condition["c"].avg_incremental_commits_applied == 7.0


def test_aggregate_convergence_rate_excludes_no_consensus_cells(
    tmp_path: Path,
) -> None:
    cells = [
        # No consensus phase ran — doesn't count toward convergence rate.
        _cell(
            condition_name="c",
            metrics=CellMetrics(
                incremental_commits_attempted=1,
                incremental_commits_applied=1,
                convergence_rounds_run=0,
                convergence_round_converged=None,
                escalation_invoked=False,
            ),
            tmp_path=tmp_path,
        ),
        # Consensus ran and converged.
        _cell(
            condition_name="c",
            metrics=CellMetrics(
                incremental_commits_attempted=0,
                incremental_commits_applied=0,
                convergence_rounds_run=1,
                convergence_round_converged=1,
                escalation_invoked=False,
            ),
            tmp_path=tmp_path,
        ),
        # Consensus ran and escalated.
        _cell(
            condition_name="c",
            metrics=CellMetrics(
                incremental_commits_attempted=0,
                incremental_commits_applied=0,
                convergence_rounds_run=2,
                convergence_round_converged=None,
                escalation_invoked=True,
            ),
            tmp_path=tmp_path,
        ),
    ]
    result = aggregate(cells)
    # 1 of 2 consensus-running cells converged.
    assert result.by_condition["c"].convergence_rate == 0.5


def test_aggregate_convergence_rate_zero_when_no_consensus_cells(
    tmp_path: Path,
) -> None:
    cells = [
        _cell(condition_name="c", tmp_path=tmp_path),
    ]
    result = aggregate(cells)
    assert result.by_condition["c"].convergence_rate == 0.0


def test_avg_scores_dict_is_read_only(tmp_path: Path) -> None:
    """ConditionSummary is frozen but the score dict needs an
    immutable view too — frozen=True only locks attribute reassignment,
    not mutation of mutable values it holds."""
    cells = [
        _cell(
            condition_name="c",
            eval_scores=[
                Score(dimension="d", value=0.5, source=ScoreSource.LLM_JUDGE),
            ],
            tmp_path=tmp_path,
        ),
    ]
    result = aggregate(cells)
    summary = result.by_condition["c"]
    import pytest

    with pytest.raises(TypeError):
        # MappingProxyType blocks item assignment.
        summary.avg_scores_by_dimension["d"] = 999.0  # type: ignore[index]


def test_condition_summary_is_frozen() -> None:
    summary = ConditionSummary(
        condition_name="x",
        n_cells=1,
        avg_scores_by_dimension={},
        avg_incremental_commits_applied=0.0,
        convergence_rate=0.0,
    )
    import dataclasses

    import pytest

    with pytest.raises(dataclasses.FrozenInstanceError):
        summary.condition_name = "y"  # type: ignore[misc]
