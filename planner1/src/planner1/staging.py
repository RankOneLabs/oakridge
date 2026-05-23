"""In-memory staging buffer for a single planner 1 run."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from .errors import StagingCycleError, StagingIndexOutOfRangeError
from .result import Err, Ok, Result

logger = logging.getLogger(__name__)


class _ToposortCycle(Exception):
    """Internal-only signal raised by ``toposort`` when a cycle is detected.

    ``toposort`` is a private helper, so it keeps a raise-on-programmer-error
    contract (per ``standards/backend.md``: try/catch lives only at IO edges,
    but pure-internal helpers may signal invariants by raising). The single
    caller — ``add_cohort_dependency`` — catches this and converts to a
    :class:`StagingCycleError` ``Err`` for its public surface.
    """


@dataclass
class StagedCohort:
    cohort_index: int
    title: str
    notes: str
    priority: int = 0


@dataclass
class StagedDependency:
    cohort_index: int
    depends_on_cohort_index: int


@dataclass
class StagingBuffer:
    parent_task_id: int
    cohorts: list[StagedCohort] = field(default_factory=list)
    dependencies: list[StagedDependency] = field(default_factory=list)

    def add_cohort(self, *, title: str, notes: str, priority: int = 0) -> StagedCohort:
        idx = len(self.cohorts)
        cohort = StagedCohort(cohort_index=idx, title=title, notes=notes, priority=priority)
        self.cohorts.append(cohort)
        logger.info(
            "staged cohort: parent_task_id=%s cohort_index=%s title=%r priority=%s",
            self.parent_task_id,
            idx,
            title,
            priority,
        )
        return cohort

    def add_cohort_dependency(
        self, *, cohort_index: int, depends_on_cohort_index: int
    ) -> Result[StagedDependency, StagingCycleError | StagingIndexOutOfRangeError]:
        if cohort_index == depends_on_cohort_index:
            logger.warning(
                "rejected self-dependency: parent_task_id=%s cohort_index=%s",
                self.parent_task_id,
                cohort_index,
            )
            return Err(
                StagingCycleError(
                    op_name="add_cohort_dependency",
                    entity_id=cohort_index,
                    detail=f"cohort {cohort_index} cannot depend on itself",
                )
            )
        n = len(self.cohorts)
        if cohort_index < 0 or cohort_index >= n:
            logger.warning(
                "rejected out-of-range cohort_index: parent_task_id=%s cohort_index=%s have=%s",
                self.parent_task_id,
                cohort_index,
                n,
            )
            return Err(
                StagingIndexOutOfRangeError(
                    op_name="add_cohort_dependency",
                    entity_id=cohort_index,
                    detail=f"cohort_index {cohort_index} out of range (have {n})",
                )
            )
        if depends_on_cohort_index < 0 or depends_on_cohort_index >= n:
            logger.warning(
                "rejected out-of-range depends_on_cohort_index: "
                "parent_task_id=%s depends_on_cohort_index=%s have=%s",
                self.parent_task_id,
                depends_on_cohort_index,
                n,
            )
            return Err(
                StagingIndexOutOfRangeError(
                    op_name="add_cohort_dependency",
                    entity_id=depends_on_cohort_index,
                    detail=(
                        f"depends_on_cohort_index {depends_on_cohort_index} "
                        f"out of range (have {n})"
                    ),
                )
            )
        for d in self.dependencies:
            if (
                d.cohort_index == cohort_index
                and d.depends_on_cohort_index == depends_on_cohort_index
            ):
                logger.info(
                    "duplicate dependency edge (idempotent): "
                    "parent_task_id=%s cohort_index=%s depends_on=%s",
                    self.parent_task_id,
                    cohort_index,
                    depends_on_cohort_index,
                )
                return Ok(d)
        edge = StagedDependency(
            cohort_index=cohort_index, depends_on_cohort_index=depends_on_cohort_index
        )
        self.dependencies.append(edge)
        try:
            self.toposort()
        except _ToposortCycle as e:
            self.dependencies.pop()
            logger.warning(
                "rejected cycle: parent_task_id=%s cohort_index=%s depends_on=%s detail=%s",
                self.parent_task_id,
                cohort_index,
                depends_on_cohort_index,
                e,
            )
            return Err(
                StagingCycleError(
                    op_name="add_cohort_dependency",
                    entity_id=cohort_index,
                    detail=str(e) or "dependency graph contains a cycle",
                )
            )
        logger.info(
            "accepted dependency edge: parent_task_id=%s cohort_index=%s depends_on=%s",
            self.parent_task_id,
            cohort_index,
            depends_on_cohort_index,
        )
        return Ok(edge)

    def toposort(self) -> list[int]:
        """Kahn's algorithm. Returns cohort indices in a dependency-respecting order.

        Internal helper: raises ``_ToposortCycle`` on a cycle. Only
        :meth:`add_cohort_dependency` should call this; that method catches the
        exception and converts to a typed ``Err`` for its public surface.
        """
        in_degree: dict[int, int] = {c.cohort_index: 0 for c in self.cohorts}
        adjacency: dict[int, list[int]] = {c.cohort_index: [] for c in self.cohorts}
        for dep in self.dependencies:
            adjacency[dep.depends_on_cohort_index].append(dep.cohort_index)
            in_degree[dep.cohort_index] = in_degree.get(dep.cohort_index, 0) + 1
        queue = [i for i, d in in_degree.items() if d == 0]
        order: list[int] = []
        while queue:
            node = queue.pop(0)
            order.append(node)
            for nxt in adjacency[node]:
                in_degree[nxt] -= 1
                if in_degree[nxt] == 0:
                    queue.append(nxt)
        if len(order) != len(self.cohorts):
            raise _ToposortCycle("dependency graph contains a cycle")
        return order

    def to_payload(self, *, summary: str, model: str) -> dict[str, Any]:
        return {
            "summary": summary,
            "model": model,
            "cohorts": [
                {
                    "cohort_index": c.cohort_index,
                    "title": c.title,
                    "notes": c.notes,
                    "priority": c.priority,
                }
                for c in self.cohorts
            ],
            "dependencies": [
                {
                    "cohort_index": d.cohort_index,
                    "depends_on_cohort_index": d.depends_on_cohort_index,
                }
                for d in self.dependencies
            ],
        }
