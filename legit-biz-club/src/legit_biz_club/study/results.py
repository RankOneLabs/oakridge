"""Aggregate :class:`CellResult` instances into per-condition summaries.

Lightweight rollup — for v1, average eval scores by dimension,
convergence rate (fraction of cells where convergence fired vs
escalated), and apply counts. Cross-condition comparison and
significance testing are downstream concerns; the harness emits a
shape that's straightforward to feed into a notebook or a stats
script.
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from jig.core.types import Score

from legit_biz_club.study.runner import CellResult


@dataclass(frozen=True, slots=True)
class ConditionSummary:
    """Per-condition rollup across cells.

    ``avg_scores_by_dimension`` is the mean over cells whose
    ``eval_scores`` contained that dimension. A dimension that's only
    relevant to one target (e.g., a prose-only criterion) shows up
    here only if the cells under this condition included that target.
    """

    condition_name: str
    n_cells: int
    avg_scores_by_dimension: dict[str, float]
    avg_incremental_commits_applied: float
    convergence_rate: float


@dataclass(frozen=True, slots=True)
class StudyResult:
    """Aggregate of every cell in a study run."""

    cells: tuple[CellResult, ...]
    by_condition: dict[str, ConditionSummary]


def aggregate(cells: Iterable[CellResult]) -> StudyResult:
    """Group cells by ``condition_name`` and roll up each group.

    Stable across study runs — the per-condition summary is a
    function of the cells in that group, no hidden state. Pass the
    full ``run_study()`` output and pull out
    ``study_result.by_condition`` for charting.
    """
    cell_list = tuple(cells)
    by_condition: dict[str, list[CellResult]] = defaultdict(list)
    for cell in cell_list:
        by_condition[cell.condition_name].append(cell)
    summaries: dict[str, ConditionSummary] = {
        name: _summarize_condition(name, group)
        for name, group in by_condition.items()
    }
    return StudyResult(cells=cell_list, by_condition=summaries)


def _summarize_condition(
    name: str, cells: Sequence[CellResult]
) -> ConditionSummary:
    return ConditionSummary(
        condition_name=name,
        n_cells=len(cells),
        avg_scores_by_dimension=_avg_scores_by_dimension(
            score for cell in cells for score in cell.eval_scores
        ),
        avg_incremental_commits_applied=_mean(
            cell.metrics.incremental_commits_applied for cell in cells
        ),
        convergence_rate=_convergence_rate(cells),
    )


def _avg_scores_by_dimension(
    scores: Iterable[Score],
) -> dict[str, float]:
    by_dim: dict[str, list[float]] = defaultdict(list)
    for score in scores:
        by_dim[score.dimension].append(score.value)
    return {dim: sum(values) / len(values) for dim, values in by_dim.items()}


def _mean(values: Iterable[float]) -> float:
    items = list(values)
    if not items:
        return 0.0
    return sum(items) / len(items)


def _convergence_rate(cells: Sequence[CellResult]) -> float:
    """Fraction of cells where convergence fired (vs escalated or
    convergence-not-applicable).

    Cells without a consensus phase (e.g., INCREMENTAL_ONLY) don't
    count toward the denominator — the rate is meaningful only over
    cells that actually ran consensus. If no cells ran consensus,
    returns 0.0.
    """
    relevant = [c for c in cells if c.metrics.convergence_rounds_run > 0]
    if not relevant:
        return 0.0
    converged = sum(
        1
        for c in relevant
        if c.metrics.convergence_round_converged is not None
    )
    return converged / len(relevant)
