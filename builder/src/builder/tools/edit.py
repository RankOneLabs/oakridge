"""EditTool: substring substitution on an existing file."""
from __future__ import annotations

import json
from typing import Any

from jig.core.types import Tool, ToolDefinition

from .base import BuildContext, ToolError, resolve_in_workdir


class EditTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: BuildContext) -> None:
        self._ctx = ctx

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="Edit",
            description=(
                "Replace old_string with new_string in the file at path. "
                "By default old_string must occur exactly once; pass "
                "replace_all=true to substitute every occurrence."
            ),
            parameters={
                "type": "object",
                "required": ["path", "old_string", "new_string"],
                "properties": {
                    "path": {"type": "string"},
                    "old_string": {"type": "string"},
                    "new_string": {"type": "string"},
                    "replace_all": {"type": "boolean", "default": False},
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        try:
            path = resolve_in_workdir(self._ctx.workdir, str(args["path"]))
            old_string = str(args["old_string"])
            new_string = str(args["new_string"])
            replace_all = bool(args.get("replace_all", False))
        except (KeyError, TypeError, ToolError) as e:
            return json.dumps({"error": str(e)})
        if not old_string:
            return json.dumps({"error": "old_string must be non-empty"})
        try:
            content = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return json.dumps({"error": f"file not found: {args['path']}"})
        count = content.count(old_string)
        if count == 0:
            return json.dumps({"error": "old_string not found"})
        if not replace_all and count > 1:
            return json.dumps(
                {
                    "error": f"old_string occurs {count} times; "
                    "set replace_all=true or pick a unique snippet"
                }
            )
        if replace_all:
            new_content = content.replace(old_string, new_string)
            replacements = count
        else:
            new_content = content.replace(old_string, new_string, 1)
            replacements = 1
        try:
            path.write_text(new_content, encoding="utf-8")
        except OSError as e:
            return json.dumps({"error": f"write failed: {e}"})
        return json.dumps({"path": str(path), "replacements": replacements})
