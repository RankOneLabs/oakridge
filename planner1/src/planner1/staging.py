"""In-memory staging buffer for a single planner 1 run."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class CycleError(ValueError):
    """Raised when the staged dependency graph contains a cycle."""


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
        return cohort

    def add_cohort_dependency(
        self, *, cohort_index: int, depends_on_cohort_index: int
    ) -> StagedDependency:
        if cohort_index == depends_on_cohort_index:
            raise CycleError(f"cohort {cohort_index} cannot depend on itself")
        if cohort_index < 0 or cohort_index >= len(self.cohorts):
            raise IndexError(f"cohort_index {cohort_index} out of range (have {len(self.cohorts)})")
        if depends_on_cohort_index < 0 or depends_on_cohort_index >= len(self.cohorts):
            n = len(self.cohorts)
            raise IndexError(
                f"depends_on_cohort_index {depends_on_cohort_index} out of range (have {n})"
            )
        for d in self.dependencies:
            if (
                d.cohort_index == cohort_index
                and d.depends_on_cohort_index == depends_on_cohort_index
            ):
                return d
        edge = StagedDependency(
            cohort_index=cohort_index, depends_on_cohort_index=depends_on_cohort_index
        )
        self.dependencies.append(edge)
        try:
            self.toposort()
        except CycleError:
            self.dependencies.pop()
            raise
        return edge

    def toposort(self) -> list[int]:
        """Kahn's algorithm. Returns cohort indices in a dependency-respecting order."""
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
            raise CycleError("dependency graph contains a cycle")
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
