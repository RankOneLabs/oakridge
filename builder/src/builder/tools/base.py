"""Shared infrastructure for build-agent tools."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class ToolError(Exception):
    """Tool returned an error result (not a Python exception)."""


@dataclass
class BuildContext:
    workdir: Path
    permission_rules: dict[str, Any] = field(default_factory=dict)


def resolve_in_workdir(workdir: Path, raw_path: str) -> Path:
    """Resolve a tool-supplied path relative to the workdir, reject escapes.

    Both absolute and relative inputs are supported; both must resolve
    inside workdir after `Path.resolve()`. A symlink that points outside
    the workdir is treated as an escape.
    """
    workdir_resolved = workdir.resolve()
    p = Path(raw_path)
    if not p.is_absolute():
        p = workdir_resolved / p
    p_resolved = p.resolve()
    try:
        p_resolved.relative_to(workdir_resolved)
    except ValueError as e:
        raise ToolError(
            f"path {raw_path!r} resolves outside workdir {workdir_resolved}"
        ) from e
    return p_resolved
