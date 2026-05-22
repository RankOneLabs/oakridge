"""Aggregate eval_scores.json across replicates for v1 study runs.

Walks one or more groups of run-roots (e.g. weak-tier, tier-up),
collects per-cell eval_scores by (target, condition), and prints a
side-by-side comparison table with mean and 95%-CI half-widths per
dimension.

Usage::

    uv run python scripts/aggregate_v1_grid.py \\
        --group "weak=.run/2026-05-08T1[4-9]*-weak*" \\
        --group "tier-up=.run/2026-05-08T1[4-9]*-tierup*"

Group spec format: ``LABEL=GLOB``. The script does NOT distinguish
which model pool a run used — that's caller-supplied via the LABEL.
Use distinct prefix paths or globs to keep groups separate. If the
same run-root matches multiple groups, it will be counted in each.

Output is plain text (mirrors the handoff doc's table). 95%-CI is
computed via the sample stderr (s/sqrt(n)) × 1.96; with n=10 and
clipped [0,1] scores this is a rough bound, not exact.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import re
import statistics
import sys
from collections import defaultdict
from collections.abc import Sequence
from pathlib import Path

_REPO_LBC = Path(__file__).resolve().parent.parent

_DIMENSIONS = ("tests", "mypy", "perf")

# Strip the ``_n<int>`` suffix from ensemble condition names so cells
# from runs at different ensemble sizes still group together.
_N_SUFFIX_RE = re.compile(r"_n\d+$")


def _normalize_condition(name: str) -> str:
    return _N_SUFFIX_RE.sub("", name)


def _ci_halfwidth(values: Sequence[float]) -> float:
    """Return the 95%-CI half-width on the mean of ``values``.

    Uses the normal-approximation (1.96 × stderr). For n<2 returns
    NaN — there's no meaningful spread on a single sample.
    """
    if len(values) < 2:
        return float("nan")
    sd = statistics.stdev(values)
    return 1.96 * sd / math.sqrt(len(values))


def _collect(
    run_roots: list[Path],
) -> tuple[
    dict[tuple[str, str], dict[str, list[float]]],
    dict[tuple[str, str], int],
]:
    """Walk run-roots and collect dimension scores + cell_failed counts.

    Returns ``(scores, failed_counts)`` where ``scores`` is
    ``{(target, condition_norm): {dim: [...]}}`` and ``failed_counts``
    is ``{(target, condition_norm): n_failed}``. A cell counts as
    failed if its events.jsonl contains a ``cell_failed`` event —
    crashes before run_cell could write eval_scores.json. Cells with
    eval_scores.json + cell_failed are double-counted by design (a
    partial run that wrote scores then crashed has both).
    """
    scores: dict[tuple[str, str], dict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    failed: dict[tuple[str, str], int] = defaultdict(int)
    for root in run_roots:
        for scores_path in root.rglob("eval_scores.json"):
            # Path layout: <root>/<target>/<condition>/eval_scores.json
            try:
                rel = scores_path.relative_to(root)
            except ValueError:
                continue
            parts = rel.parts
            if len(parts) != 3:
                continue
            target, condition, _ = parts
            condition_norm = _normalize_condition(condition)
            try:
                data = json.loads(scores_path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            for entry in data.get("scores", []):
                dim = entry.get("dimension")
                value = entry.get("value")
                if dim in _DIMENSIONS and isinstance(value, int | float):
                    scores[(target, condition_norm)][dim].append(float(value))
        # Separate pass for cell_failed so cells that crashed before
        # writing eval_scores.json are still counted.
        for events_path in root.rglob("events.jsonl"):
            try:
                rel = events_path.relative_to(root)
            except ValueError:
                continue
            parts = rel.parts
            if len(parts) != 3:
                continue
            target, condition, _ = parts
            condition_norm = _normalize_condition(condition)
            try:
                with events_path.open(encoding="utf-8") as f:
                    for line in f:
                        if '"cell_failed"' in line:
                            failed[(target, condition_norm)] += 1
                            break
            except OSError:
                continue
    return scores, failed


def _format_cell(values: Sequence[float]) -> str:
    if not values:
        return "—"
    mean = statistics.mean(values)
    if len(values) < 2:
        return f"{mean:.2f}"
    ci = _ci_halfwidth(values)
    return f"{mean:.2f}±{ci:.2f}"


def _print_table(
    groups: list[
        tuple[
            str,
            dict[tuple[str, str], dict[str, list[float]]],
            dict[tuple[str, str], int],
        ]
    ],
) -> None:
    """Print one block per (target) — within each, rows are conditions
    and columns are (group × dimension)."""
    targets = sorted({t for _, agg, _ in groups for (t, _) in agg.keys()})
    conditions_order = [
        "single_agent",
        "ensemble_incremental",
        "ensemble_single_round",
        "ensemble_multi_round",
    ]

    for target in targets:
        print(f"\n=== {target} ===\n")
        # Header
        cond_col_w = max(len(c) for c in conditions_order) + 2
        # Per group, three dimension columns, each wide enough for "0.00±0.00"
        dim_col_w = 12
        header_groups = "  |  ".join(
            f"{label:<{dim_col_w * len(_DIMENSIONS) + (len(_DIMENSIONS) - 1) * 2}}"
            for label, _, _ in groups
        )
        print(f"{'condition':<{cond_col_w}}  {header_groups}")
        sub_header = "  |  ".join(
            "  ".join(f"{d:<{dim_col_w}}" for d in _DIMENSIONS)
            for _ in groups
        )
        print(f"{'':<{cond_col_w}}  {sub_header}")
        print()

        for cond in conditions_order:
            row_group_cells = []
            for _, agg, _ in groups:
                cell = agg.get((target, cond), {})
                dim_cells = "  ".join(
                    f"{_format_cell(cell.get(d, [])):<{dim_col_w}}"
                    for d in _DIMENSIONS
                )
                row_group_cells.append(dim_cells)
            print(
                f"{cond:<{cond_col_w}}  {'  |  '.join(row_group_cells)}"
            )

        # Per-condition n + failure breakdown — a condition can have
        # different n per dimension if some cells crashed before
        # producing all dims. Surface failures explicitly.
        print()
        print("  per-condition n (tests / mypy / perf) + cell_failed:")
        for cond in conditions_order:
            ns_per_group = []
            for label, agg, fcounts in groups:
                cell = agg.get((target, cond), {})
                ns = "/".join(str(len(cell.get(d, []))) for d in _DIMENSIONS)
                f = fcounts.get((target, cond), 0)
                ns_per_group.append(
                    f"{label}={ns} (failed={f})" if f else f"{label}={ns}"
                )
            print(f"    {cond:<{cond_col_w}}  {'  '.join(ns_per_group)}")


def _parse_group(spec: str) -> tuple[str, list[Path]]:
    if "=" not in spec:
        raise argparse.ArgumentTypeError(
            f"--group expected LABEL=GLOB, got {spec!r}"
        )
    label, pattern = spec.split("=", 1)
    label = label.strip()
    pattern = pattern.strip()
    if not label or not pattern:
        raise argparse.ArgumentTypeError(
            f"--group LABEL and GLOB must be non-empty: {spec!r}"
        )
    # Allow ``;``-separated multi-glob so callers don't need shell
    # brace expansion (which glob.glob doesn't support).
    sub_patterns = [p.strip() for p in pattern.split(";") if p.strip()]
    matches: list[Path] = []
    for sub in sub_patterns:
        # Resolve relative globs against the repo root, mirroring the
        # runner's _REPO_LBC base. Absolute globs pass through.
        if not Path(sub).is_absolute():
            sub = str(_REPO_LBC / sub)
        matches.extend(Path(p) for p in glob.glob(sub))
    matches = sorted(set(matches))
    if not matches:
        raise argparse.ArgumentTypeError(
            f"--group {label!r}: no run-roots matched {pattern!r}"
        )
    return label, matches


def main() -> int:
    p = argparse.ArgumentParser(
        prog="aggregate_v1_grid.py",
        description=(
            "Aggregate eval_scores.json across replicates and groups. "
            "Each --group is LABEL=GLOB; LABEL is what shows up in the "
            "table header (e.g. weak / tier-up)."
        ),
    )
    p.add_argument(
        "--group",
        action="append",
        type=_parse_group,
        required=True,
        help=(
            "LABEL=GLOB. Repeat to compare multiple groups side-by-side. "
            "GLOB is resolved relative to the legit-biz-club repo root."
        ),
    )
    args = p.parse_args()

    groups = []
    for label, roots in args.group:
        scores, failed = _collect(roots)
        groups.append((label, scores, failed))

    print("Run-root counts:")
    for (label, roots), (_, agg, fcounts) in zip(args.group, groups):
        cell_count = sum(
            len(s)
            for dims in agg.values()
            for s in dims.values()
        )
        total_failed = sum(fcounts.values())
        print(
            f"  {label}: {len(roots)} run-roots, "
            f"{sum(len(d) for d in agg.values())} (target,condition) keys, "
            f"{cell_count} dimension scores, "
            f"{total_failed} cell_failed"
        )

    _print_table(groups)
    return 0


if __name__ == "__main__":
    sys.exit(main())
