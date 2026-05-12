"""ReadTool: read a file from the workdir."""
from __future__ import annotations

import json
from typing import Any

from jig.core.types import Tool, ToolDefinition

from .base import BuildContext, ToolError, resolve_in_workdir


class ReadTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: BuildContext) -> None:
        self._ctx = ctx

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="Read",
            description=(
                "Read a file from the working directory. Returns the file's "
                "content as a raw string. Use this before editing a file."
            ),
            parameters={
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path relative to workdir, or absolute inside workdir.",
                    },
                    "numbered": {
                        "type": "boolean",
                        "description": "Prefix lines with 1-indexed numbers (rare; default false).",
                        "default": False,
                    },
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        try:
            path = resolve_in_workdir(self._ctx.workdir, str(args["path"]))
            numbered = bool(args.get("numbered", False))
        except (KeyError, TypeError, ToolError) as e:
            return json.dumps({"error": str(e)})
        try:
            content = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return json.dumps({"error": f"file not found: {args['path']}"})
        except IsADirectoryError:
            return json.dumps({"error": f"is a directory: {args['path']}"})
        except UnicodeDecodeError as e:
            return json.dumps({"error": f"file is not utf-8: {e}"})
        if numbered:
            lines = content.split("\n")
            return "\n".join(f"{i+1}\t{line}" for i, line in enumerate(lines))
        return content
