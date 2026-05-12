"""jig Tool subclasses that write into a StagingBuffer.

jig's Tool ABC (jig/core/types.py): exposes a `definition` property returning a
ToolDefinition and an `async execute(args: dict) -> str`. No per-call context
is passed by jig; the buffer is captured in __init__.
"""
from __future__ import annotations

import json
from typing import Any

from jig.core.types import Tool, ToolDefinition

from .staging import CycleError, StagingBuffer


class CreateTaskTool(Tool):  # type: ignore[misc]
    def __init__(self, buffer: StagingBuffer) -> None:
        self._buffer = buffer

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="create_task",
            description=(
                "Stage a child task (a brief) under the spec's root task. The brief is markdown "
                "sized so a build agent (Sonnet/Haiku tier) could execute it after a planner-2 "
                "pass adds the missing decisions. Returns staged_task_index (0-based) for use in "
                "add_dependency calls."
            ),
            parameters={
                "type": "object",
                "required": ["title", "notes"],
                "properties": {
                    "title": {"type": "string", "description": "One-line title for the brief."},
                    "notes": {
                        "type": "string",
                        "description": "Markdown body. State goal, surface area, exit criteria.",
                    },
                    "priority": {
                        "type": "integer",
                        "description": "Optional priority (higher = sooner). Default 0.",
                        "default": 0,
                    },
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        title = str(args["title"])
        notes = str(args["notes"])
        priority = int(args.get("priority", 0))
        task = self._buffer.add_task(title=title, notes=notes, priority=priority)
        return json.dumps({"staged_task_index": task.index, "title": task.title})


class AddDependencyTool(Tool):  # type: ignore[misc]
    def __init__(self, buffer: StagingBuffer) -> None:
        self._buffer = buffer

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="add_dependency",
            description=(
                "Declare that task_index cannot start until depends_on_index is done. Indices "
                "are 0-based and refer to the order in which create_task was called. Cycles "
                "(direct or transitive) are rejected; the tool returns {\"error\": \"...\"} on "
                "rejection so you can correct and try again."
            ),
            parameters={
                "type": "object",
                "required": ["task_index", "depends_on_index"],
                "properties": {
                    "task_index": {
                        "type": "integer",
                        "description": "Index of the staged task that's blocked.",
                    },
                    "depends_on_index": {
                        "type": "integer",
                        "description": "Index of the staged task that must complete first.",
                    },
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        try:
            edge = self._buffer.add_dependency(
                task_index=int(args["task_index"]),
                depends_on_index=int(args["depends_on_index"]),
            )
        except (CycleError, IndexError) as e:
            return json.dumps({"error": str(e)})
        return json.dumps(
            {"task_index": edge.task_index, "depends_on_index": edge.depends_on_index}
        )
