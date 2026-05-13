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


class CreateCohortTool(Tool):  # type: ignore[misc]
    def __init__(self, buffer: StagingBuffer) -> None:
        self._buffer = buffer

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="create_cohort",
            description=(
                "Stage a cohort under the spec's plan. Each cohort is a parallelizable unit of "
                "work sized for a build agent. Returns cohort_index (0-based) for use in "
                "add_cohort_dependency calls."
            ),
            parameters={
                "type": "object",
                "required": ["title", "notes"],
                "properties": {
                    "title": {"type": "string", "description": "One-line title for the cohort."},
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
        try:
            title = str(args["title"])
            notes = str(args["notes"])
            priority = int(args.get("priority", 0))
        except (KeyError, TypeError, ValueError) as e:
            return json.dumps({"error": f"invalid arguments: {e}"})
        cohort = self._buffer.add_cohort(title=title, notes=notes, priority=priority)
        return json.dumps({"cohort_index": cohort.cohort_index, "title": cohort.title})


class AddCohortDependencyTool(Tool):  # type: ignore[misc]
    def __init__(self, buffer: StagingBuffer) -> None:
        self._buffer = buffer

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="add_cohort_dependency",
            description=(
                "Declare that cohort_index cannot start until depends_on_cohort_index is done. "
                "Indices are 0-based and refer to the order in which create_cohort was called. "
                "Cycles (direct or transitive) are rejected; the tool returns {\"error\": \"...\"} "
                "on rejection so you can correct and try again."
            ),
            parameters={
                "type": "object",
                "required": ["cohort_index", "depends_on_cohort_index"],
                "properties": {
                    "cohort_index": {
                        "type": "integer",
                        "description": "Index of the staged cohort that's blocked.",
                    },
                    "depends_on_cohort_index": {
                        "type": "integer",
                        "description": "Index of the staged cohort that must complete first.",
                    },
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        try:
            edge = self._buffer.add_cohort_dependency(
                cohort_index=int(args["cohort_index"]),
                depends_on_cohort_index=int(args["depends_on_cohort_index"]),
            )
        except (CycleError, IndexError, KeyError, TypeError, ValueError) as e:
            return json.dumps({"error": str(e)})
        return json.dumps(
            {
                "cohort_index": edge.cohort_index,
                "depends_on_cohort_index": edge.depends_on_cohort_index,
            }
        )
