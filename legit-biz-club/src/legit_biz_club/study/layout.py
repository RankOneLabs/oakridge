"""Shared cell layout constants and helpers for the study harness.

All callers that need to know *where* a cell lives on disk, or *what*
filenames are reserved by the harness, import from here.  Having one
source of truth makes drift between runner.py and run.py structurally
impossible: adding a sidecar only requires updating this module.
"""
from __future__ import annotations

from pathlib import Path

# Names that the harness colocates with the artifact inside the cell
# directory.  Reserving these prevents a target spec from clobbering
# (or being clobbered by) a sidecar file.
#
# - commits/      — per-commit snapshots written by Mediator
# - agent_memory/ — per-agent SqliteStore files
# - events.jsonl  — workspace event log written by the driver tee
# - eval_scores.json — grader output written by _write_eval_scores_sidecar
RESERVED_SIDECAR_NAMES: frozenset[str] = frozenset(
    {"commits", "agent_memory", "events.jsonl", "eval_scores.json"}
)

# Casefolded copy for membership checks.  The harness may run on
# case-insensitive filesystems (macOS APFS, Windows NTFS) where
# ``Eval_Scores.json`` and ``eval_scores.json`` resolve to the same
# on-disk file.  All callers must use this set (or is_reserved_sidecar_name)
# rather than the canonical-case set.
_RESERVED_SIDECAR_NAMES_CASEFOLDED: frozenset[str] = frozenset(
    n.casefold() for n in RESERVED_SIDECAR_NAMES
)


def is_reserved_sidecar_name(name: str) -> bool:
    """Return True when *name* (after casefolding) collides with a reserved sidecar."""
    return name.casefold() in _RESERVED_SIDECAR_NAMES_CASEFOLDED


def cell_dir_name(target_name: str, condition_name: str) -> str:
    """Return the relative subpath string for a cell: ``"{target}/{condition}"``."""
    return f"{target_name}/{condition_name}"


def cell_dir_path(output_dir: Path, target_name: str, condition_name: str) -> Path:
    """Return the absolute cell directory: ``output_dir/{target_name}/{condition_name}``."""
    return output_dir / target_name / condition_name
