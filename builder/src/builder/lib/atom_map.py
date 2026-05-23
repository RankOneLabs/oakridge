"""Pure helpers for inspecting the atom-map shape used by review responders.

The plan and build-brief review responders both manipulate a flat
``dict[str, str]`` atom map (anchor -> serialized value). The index
allocation, cohort enumeration, edge parsing, and cycle detection live
here so handlers contain only orchestration.
"""
from __future__ import annotations

import re

LIST_FIELDS = frozenset(
    [
        "active_subgoals",
        "decisions_made",
        "approaches_rejected",
        "files_in_scope",
        "open_questions",
    ]
)


def list_keys(atom_map: dict[str, str], field: str) -> list[str]:
    """Return list anchor keys for ``field`` sorted by their index."""
    pattern = re.compile(rf"^{re.escape(field)}\[(\d+)\]$")
    keys = [(int(m.group(1)), k) for k in atom_map if (m := pattern.match(k))]
    return [k for _, k in sorted(keys)]


def next_list_index(atom_map: dict[str, str], field: str) -> int:
    """Return the next free index for ``field`` (one past the last seen)."""
    keys = list_keys(atom_map, field)
    if not keys:
        return 0
    last = keys[-1]
    m = re.search(r"\[(\d+)\]$", last)
    return int(m.group(1)) + 1 if m else 0


def cohort_indices(atom_map: dict[str, str]) -> set[int]:
    """Return the set of cohort indices present in the atom map."""
    pattern = re.compile(r"^cohorts\[(\d+)\]")
    return {int(m.group(1)) for k in atom_map if (m := pattern.match(k))}


def next_cohort_index(atom_map: dict[str, str]) -> int:
    """Return the next free cohort index (one past max, or 0 if empty)."""
    existing = cohort_indices(atom_map)
    return (max(existing) + 1) if existing else 0


def parse_edge_keys(atom_map: dict[str, str]) -> set[tuple[int, int]]:
    """Return the set of dependency edges encoded in the atom map."""
    pattern = re.compile(r"^deps\[(\d+),(\d+)\]$")
    edges: set[tuple[int, int]] = set()
    for k in atom_map:
        if m := pattern.match(k):
            edges.add((int(m.group(1)), int(m.group(2))))
    return edges


def would_create_cycle(
    existing_edges: set[tuple[int, int]], new_from: int, new_to: int
) -> bool:
    """True if adding ``(new_from, new_to)`` to ``existing_edges`` creates a cycle."""
    if new_from == new_to:
        return True
    adj: dict[int, list[int]] = {}
    for f, t in existing_edges:
        adj.setdefault(f, []).append(t)
    visited: set[int] = set()
    stack = [new_to]
    while stack:
        node = stack.pop()
        if node == new_from:
            return True
        if node in visited:
            continue
        visited.add(node)
        stack.extend(adj.get(node, []))
    return False
