"""GrepTool: ripgrep-backed content search."""
from __future__ import annotations

import json
import shutil
import subprocess
from typing import Any

from jig.core.types import Tool, ToolDefinition

from .base import BuildContext, ToolError, resolve_in_workdir

_TRUNCATE = 30000


class GrepTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: BuildContext) -> None:
        self._ctx = ctx

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="Grep",
            description=(
                "Search file contents with ripgrep. output_mode: "
                "files_with_matches (default), content, or count."
            ),
            parameters={
                "type": "object",
                "required": ["pattern"],
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {"type": "string"},
                    "glob": {"type": "string"},
                    "output_mode": {
                        "type": "string",
                        "enum": ["files_with_matches", "content", "count"],
                        "default": "files_with_matches",
                    },
                    "case_insensitive": {"type": "boolean", "default": False},
                    "line_numbers": {"type": "boolean", "default": False},
                    "head_limit": {"type": "integer", "default": 250},
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        if not shutil.which("rg"):
            return json.dumps({"error": "ripgrep (rg) not installed on host"})
        try:
            pattern = str(args["pattern"])
            search_path = (
                resolve_in_workdir(self._ctx.workdir, str(args["path"]))
                if args.get("path")
                else self._ctx.workdir
            )
            glob = args.get("glob")
            output_mode = str(args.get("output_mode", "files_with_matches"))
            case_insensitive = bool(args.get("case_insensitive", False))
            line_numbers = bool(args.get("line_numbers", False))
            head_limit = int(args.get("head_limit", 250))
        except (KeyError, TypeError, ValueError, ToolError) as e:
            return json.dumps({"error": str(e)})
        cmd = ["rg", "--no-config"]
        if output_mode == "files_with_matches":
            cmd.append("-l")
        elif output_mode == "count":
            cmd.append("-c")
        if case_insensitive:
            cmd.append("-i")
        if line_numbers and output_mode == "content":
            cmd.append("-n")
        if glob:
            cmd.extend(["--glob", str(glob)])
        cmd.extend(["--", pattern, str(search_path)])
        try:
            completed = subprocess.run(
                cmd,
                cwd=str(self._ctx.workdir),
                capture_output=True,
                text=True,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            return json.dumps({"error": "rg timed out"})
        if completed.returncode > 1:
            err = (completed.stderr or "").strip() or "rg failed"
            return json.dumps({"error": err, "exit_code": completed.returncode})
        if completed.returncode == 1:
            return "(no matches)"
        out_lines = (completed.stdout or "").splitlines()[:head_limit]
        out = "\n".join(out_lines)
        if len(out) > _TRUNCATE:
            out = out[:_TRUNCATE] + "\n[truncated]"
        return out or "(no matches)"
