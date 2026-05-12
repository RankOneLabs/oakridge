"""GlobTool: pattern-match files by name."""
from __future__ import annotations

import json
from typing import Any

from jig.core.types import Tool, ToolDefinition

from .base import BuildContext, ToolError, resolve_in_workdir

_LIMIT = 250


class GlobTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: BuildContext) -> None:
        self._ctx = ctx

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="Glob",
            description=(
                "Find files by glob pattern. Returns up to 250 paths sorted "
                "by mtime descending. Patterns like '**/*.py' are supported."
            ),
            parameters={
                "type": "object",
                "required": ["pattern"],
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {"type": "string", "description": "Search root; default workdir."},
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        try:
            pattern = str(args["pattern"])
            root = (
                resolve_in_workdir(self._ctx.workdir, str(args["path"]))
                if args.get("path")
                else self._ctx.workdir
            )
        except (KeyError, TypeError, ToolError) as e:
            return json.dumps({"error": str(e)})
        try:
            matches = [
                p for p in root.glob(pattern)
                if p.is_file() and p.resolve().is_relative_to(self._ctx.workdir)
            ]
        except OSError as e:
            return json.dumps({"error": f"glob failed: {e}"})
        def _safe_mtime(p: Any) -> float:
            try:
                return float(p.stat().st_mtime)
            except OSError:
                return float("-inf")

        matches.sort(key=_safe_mtime, reverse=True)
        matches = matches[:_LIMIT]
        rel = [str(p.relative_to(self._ctx.workdir)) for p in matches]
        return "\n".join(rel) or "(no matches)"
