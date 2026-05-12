"""WriteTool: overwrite or create a file in the workdir."""
from __future__ import annotations

import json
from typing import Any

from jig.core.types import Tool, ToolDefinition

from .base import BuildContext, ToolError, resolve_in_workdir


class WriteTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: BuildContext) -> None:
        self._ctx = ctx

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="Write",
            description=(
                "Write the given content to a file, overwriting any existing "
                "content. Creates parent directories as needed. Returns the "
                "path and bytes written."
            ),
            parameters={
                "type": "object",
                "required": ["path", "content"],
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        try:
            path = resolve_in_workdir(self._ctx.workdir, str(args["path"]))
            content = str(args["content"])
        except (KeyError, TypeError, ToolError) as e:
            return json.dumps({"error": str(e)})
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            n = len(content.encode("utf-8"))
        except OSError as e:
            return json.dumps({"error": f"write failed: {e}"})
        return json.dumps({"path": str(path), "bytes_written": n})
