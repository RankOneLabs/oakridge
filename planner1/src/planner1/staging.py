"""In-memory staging buffer for a single planner 1 run."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any


class CycleError(ValueError):
    """Raised when the staged dependency graph contains a cycle."""


@dataclass
class StagedTask:
    index: int
    title: str
    notes: str
    priority: int = 0


@dataclass
class StagedDependency:
    task_index: int
    depends_on_index: int


@dataclass
class StagingBuffer:
    parent_task_id: int
    tasks: list[StagedTask] = field(default_factory=list)
    dependencies: list[StagedDependency] = field(default_factory=list)

    def add_task(self, *, title: str, notes: str, priority: int = 0) -> StagedTask:
        idx = len(self.tasks)
        task = StagedTask(index=idx, title=title, notes=notes, priority=priority)
        self.tasks.append(task)
        return task

    def add_dependency(self, *, task_index: int, depends_on_index: int) -> StagedDependency:
        if task_index == depends_on_index:
            raise CycleError(f"task {task_index} cannot depend on itself")
        if task_index < 0 or task_index >= len(self.tasks):
            raise IndexError(f"task_index {task_index} out of range (have {len(self.tasks)})")
        if depends_on_index < 0 or depends_on_index >= len(self.tasks):
            n = len(self.tasks)
            raise IndexError(f"depends_on_index {depends_on_index} out of range (have {n})")
        edge = StagedDependency(task_index=task_index, depends_on_index=depends_on_index)
        self.dependencies.append(edge)
        try:
            self.toposort()
        except CycleError:
            self.dependencies.pop()
            raise
        return edge

    def toposort(self) -> list[int]:
        """Kahn's algorithm. Returns task indices in a dependency-respecting order."""
        in_degree: dict[int, int] = {t.index: 0 for t in self.tasks}
        adjacency: dict[int, list[int]] = {t.index: [] for t in self.tasks}
        for dep in self.dependencies:
            adjacency[dep.depends_on_index].append(dep.task_index)
            in_degree[dep.task_index] = in_degree.get(dep.task_index, 0) + 1
        queue = [i for i, d in in_degree.items() if d == 0]
        order: list[int] = []
        while queue:
            node = queue.pop(0)
            order.append(node)
            for nxt in adjacency[node]:
                in_degree[nxt] -= 1
                if in_degree[nxt] == 0:
                    queue.append(nxt)
        if len(order) != len(self.tasks):
            raise CycleError("dependency graph contains a cycle")
        return order

    def to_payload(self, *, summary: str, model: str) -> dict[str, Any]:
        return {
            "parent_task_id": self.parent_task_id,
            "tasks": [asdict(t) for t in self.tasks],
            "dependencies": [asdict(d) for d in self.dependencies],
            "summary": summary,
            "model": model,
            "created_at": datetime.now(UTC).isoformat(),
        }
