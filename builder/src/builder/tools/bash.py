"""BashTool: run a shell command with permission and workdir enforcement."""
from __future__ import annotations

import asyncio
import json
import re
import shlex
import subprocess
from typing import Any

from jig.core.types import Tool, ToolDefinition

from .base import BuildContext

_METACHAR_RE = re.compile(r"[|<>&;]|\$\(|\&\&|\|\|")
_TRUNCATE = 30000


class BashTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: BuildContext) -> None:
        self._ctx = ctx

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="Bash",
            description=(
                "Run a shell command in the workdir. Returns "
                "{stdout, stderr, exit_code}. 5-minute timeout."
            ),
            parameters={
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": {"type": "string"},
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "Override the default 300s timeout (max 600).",
                        "default": 300,
                    },
                },
            },
        )

    def _is_denied(self, command: str) -> bool:
        normalized = command.lstrip()
        rules = self._ctx.permission_rules
        if rules.get("allow_all") is True:
            return False
        for pat in rules.get("deny_patterns", []) or []:
            if pat.get("tool") != "Bash":
                continue
            match = pat.get("input_match") or {}
            prefixes = match.get("command_prefix") or []
            for prefix in prefixes:
                bare = prefix.rstrip()
                if normalized == bare or normalized.startswith(bare + " "):
                    return True
            regex = match.get("input_regex")
            if regex:
                try:
                    if re.search(regex, normalized):
                        return True
                except re.error:
                    return True
        return False

    async def execute(self, args: dict[str, Any]) -> str:
        try:
            command = str(args["command"])
            timeout = int(args.get("timeout_seconds", 300))
        except (KeyError, TypeError, ValueError) as e:
            return json.dumps({"error": f"invalid arguments: {e}"})
        if not command.strip():
            return json.dumps({"error": "command must be a non-empty string"})
        if timeout < 1 or timeout > 600:
            return json.dumps({"error": "timeout_seconds must be 1..600"})
        if self._is_denied(command):
            return json.dumps({"error": "denied by permission profile"})
        use_shell = bool(_METACHAR_RE.search(command))

        def _run() -> subprocess.CompletedProcess[str]:
            if use_shell:
                return subprocess.run(
                    command,
                    shell=True,
                    executable="/bin/bash",
                    cwd=str(self._ctx.workdir),
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                )
            try:
                argv = shlex.split(command)
            except ValueError as e:
                raise ValueError(f"invalid command syntax: {e}") from e
            return subprocess.run(
                argv,
                shell=False,
                cwd=str(self._ctx.workdir),
                capture_output=True,
                text=True,
                timeout=timeout,
            )

        try:
            completed = await asyncio.to_thread(_run)
        except ValueError as e:
            return json.dumps({"error": str(e)})
        except subprocess.TimeoutExpired as e:

            def _decode(b: bytes | str | None) -> str:
                if b is None:
                    return ""
                return b.decode("utf-8", errors="replace") if isinstance(b, bytes) else b

            return json.dumps(
                {
                    "stdout": _decode(e.stdout)[:_TRUNCATE],
                    "stderr": _decode(e.stderr)[:_TRUNCATE] + "\n[timeout]",
                    "exit_code": 124,
                }
            )
        except FileNotFoundError as e:
            return json.dumps({"error": f"command not found: {e}"})
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        if len(stdout) > _TRUNCATE:
            stdout = stdout[:_TRUNCATE] + "\n[truncated]"
        if len(stderr) > _TRUNCATE:
            stderr = stderr[:_TRUNCATE] + "\n[truncated]"
        return json.dumps(
            {"stdout": stdout, "stderr": stderr, "exit_code": completed.returncode}
        )
