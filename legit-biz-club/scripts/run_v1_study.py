"""Drive the v1 study grid: targets × conditions × replicates.

Loops over the cells the operator selected via CLI flags, calling
:func:`run_cell` per cell. Each replicate writes to a fresh
timestamped run-root under ``legit-biz-club/.run/`` so cell directories
don't collide on the runner's reserved sidecar children
(``commits/``, ``agent_memory/``, ``events.jsonl``,
``eval_scores.json``). The dashboard groups cells across replicates by
(target, condition) cell name.

Usage::

    cd legit-biz-club
    export ANTHROPIC_API_KEY=...
    uv run python scripts/run_v1_study.py \\
      --target prose_substrate_thesis \\
      --conditions single_agent,ensemble_incremental,ensemble_single_round,ensemble_multi_round \\
      --n 3 \\
      --replicates 2 \\
      --judge-model claude-sonnet-4-5

The default ``--model-pool`` pins writers to Anthropic-only so one
provider key suffices. Override for cross-provider runs (and supply
the matching keys in env).

Failures in one cell don't sink the whole grid — the cell is logged
and the next cell starts. The script exits non-zero if any cell
failed so CI / scheduled wrappers can detect partial-success runs.
"""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from jig.llm.factory import from_model
from jig.memory.local import SqliteStore
from jig.tracing.stdout import StdoutTracer

from legit_biz_club import (
    Agent,
    JigProposer,
    MemoryCommitter,
    OperatorConfidence,
    PeerContextLoader,
    make_sqlite_observation_loader,
)
from legit_biz_club.core.models import Project
from legit_biz_club.study.conditions import (
    ConditionConfig,
    ensemble_incremental_only,
    ensemble_with_multi_round,
    ensemble_with_single_round,
    single_agent_baseline,
)
from legit_biz_club.study.runner import GraderFactory, run_cell
from legit_biz_club.study.targets import TargetConfig
from legit_biz_club.study.v1_graders import (
    make_leetcode_longest_substring_grader_factory,
    make_leetcode_regex_matching_grader_factory,
    make_leetcode_trapping_rain_water_grader_factory,
    make_prose_substrate_thesis_grader_factory,
)
from legit_biz_club.study.v1_targets import (
    code_leetcode_longest_substring,
    code_leetcode_regex_matching,
    code_leetcode_trapping_rain_water,
    prose_substrate_thesis,
)

# --- CLI mappings ----------------------------------------------------


_TARGET_FACTORIES: dict[str, Callable[[], TargetConfig]] = {
    "prose_substrate_thesis": prose_substrate_thesis,
    "code_leetcode_longest_substring": code_leetcode_longest_substring,
    "code_leetcode_trapping_rain_water": code_leetcode_trapping_rain_water,
    "code_leetcode_regex_matching": code_leetcode_regex_matching,
}


# CLI shorthand -> condition factory. Single-agent ignores n; the
# others take it. Mirrors the table in
# ``comms/legit-biz-club-v1-study-plan.md`` (Phase 2).
_CONDITION_FACTORIES: dict[str, Callable[..., ConditionConfig]] = {
    "single_agent": lambda *, n: single_agent_baseline(),
    "ensemble_incremental": lambda *, n: ensemble_incremental_only(n=n),
    "ensemble_single_round": lambda *, n: ensemble_with_single_round(n=n),
    "ensemble_multi_round": lambda *, n: ensemble_with_multi_round(n=n),
}


# 2-model Anthropic pool — one provider key suffices. Matches
# run_one_project.py. Override at the call site for cross-provider
# runs (and bring the corresponding keys).
_DEFAULT_MODEL_POOL: tuple[str, ...] = (
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
)


# --- emit (mirrors run_one_project.py) -------------------------------


def _build_event_tee(
    jsonl_path: Path,
) -> Callable[[str, dict[str, object]], Awaitable[None]]:
    """Build an emit callback that prints AND appends to a JSONL log.

    Live print stays for terminal visibility (``flush=True`` so it
    streams when stdout is a pipe). The JSONL log is the durable
    record per-cell — the dashboard reads it via SSE.
    """
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)

    async def _emit(kind: str, payload: dict[str, object]) -> None:
        record = {
            "ts": datetime.now(UTC).isoformat(),
            "kind": kind,
            "payload": payload,
        }
        print(f"[workspace_event] {kind} :: {payload}", flush=True)
        with jsonl_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    return _emit


# --- peer context loader (kept in sync with run_one_project.py) ------


# Held constant across all cells in a study run — prior operator
# observations are an INPUT to the project, not a confound between
# conditions. Keep in sync with run_one_project.py.
_DEMO_OBSERVATIONS: list[tuple[str, OperatorConfidence, list[str]]] = [
    (
        "you tend to bury the lede in introductions; lead with the claim",
        OperatorConfidence.HIGH,
        ["style"],
    ),
    (
        "prior reviewers said your conclusions felt rushed — give them time",
        OperatorConfidence.MEDIUM,
        ["pattern"],
    ),
    (
        "you over-cite when one concrete example would do",
        OperatorConfidence.HIGH,
        ["voice"],
    ),
]


async def _stub_embed(_text: str) -> np.ndarray:
    return np.zeros(8, dtype=np.float32)


def _build_peer_context_loader(store_path: Path) -> PeerContextLoader:
    """Return a PeerContextLoader backed by a fresh SqliteStore.

    Pre-seeds the demo observations on first call per agent. The
    store path lives at the run-root (above any cell dir) so the
    runner's per-cell agent_memory rmtree doesn't wipe it.
    """
    store = SqliteStore(db_path=str(store_path), embedder=_stub_embed)
    inner_loader = make_sqlite_observation_loader(store)
    seeded: set[str] = set()

    async def _load(agent: Agent, project: Project) -> str:
        if agent.id not in seeded:
            committer = MemoryCommitter(agent, store)
            for text, confidence, tags in _DEMO_OBSERVATIONS:
                await committer.commit(
                    project_id="prior-blog-post-2026-04",
                    observation_text=text,
                    operator_confidence=confidence,
                    tags=tags,
                )
            seeded.add(agent.id)
        return await inner_loader(agent, project)

    return _load


# --- proposer --------------------------------------------------------


def _proposer_factory(agent: Agent, *, context: str = "") -> JigProposer:
    # max_tokens=16384 (vs JigProposer's 8192 default): cushion for
    # ensemble cells where the artifact + tag overhead grow past 8192
    # in later commits. 16384 stays well under every modern Claude
    # model's per-call cap and avoids tuning per-target.
    return JigProposer(agent, context=context, max_tokens=16384)


# --- run-root --------------------------------------------------------


_REPO_LBC = Path(__file__).resolve().parent.parent


def _fresh_run_root() -> Path:
    """Return a fresh ``.run/<ISO microsecond>/`` path under the repo.

    Microsecond-precision timestamps disambiguate consecutive
    replicates without colliding on the runner's reserved sidecar
    children. UTC + trailing 'Z' aligns with events.jsonl timestamps
    for post-mortem correlation.
    """
    return (
        _REPO_LBC
        / ".run"
        / datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    )


# --- argparse --------------------------------------------------------


def _parse_csv(s: str) -> list[str]:
    return [t.strip() for t in s.split(",") if t.strip()]


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="run_v1_study.py",
        description=(
            "Run the v1 study grid: targets × conditions × replicates. "
            "Each replicate writes to a fresh timestamped run-root."
        ),
    )
    p.add_argument(
        "--target",
        required=True,
        help=(
            "Comma-separated target tokens. Choices: "
            f"{', '.join(_TARGET_FACTORIES)}"
        ),
    )
    p.add_argument(
        "--conditions",
        required=True,
        help=(
            "Comma-separated condition tokens. Choices: "
            f"{', '.join(_CONDITION_FACTORIES)}"
        ),
    )
    p.add_argument(
        "--n",
        type=int,
        default=3,
        help=(
            "Ensemble size for non-single-agent conditions "
            "(default 3, design-memo default is 5)."
        ),
    )
    p.add_argument(
        "--replicates",
        type=int,
        default=1,
        help="Replicates per (target, condition) (default 1).",
    )
    p.add_argument(
        "--judge-model",
        default="claude-sonnet-4-5",
        help=(
            "LLM for the prose judge. Should NOT be in the writer "
            "pool for an honest study (default claude-sonnet-4-5). "
            "Ignored when no prose target is selected."
        ),
    )
    p.add_argument(
        "--model-pool",
        default=",".join(_DEFAULT_MODEL_POOL),
        help=(
            "Comma-separated writer model pool. Default pins to "
            "Anthropic-only so one provider key suffices."
        ),
    )
    return p


# --- main ------------------------------------------------------------


async def main() -> int:
    args = _build_argparser().parse_args()

    target_tokens = _parse_csv(args.target)
    condition_tokens = _parse_csv(args.conditions)

    # Validate at the boundary so a typo errors before any LLM cost.
    bad_targets = [t for t in target_tokens if t not in _TARGET_FACTORIES]
    if bad_targets:
        print(
            f"unknown target(s): {bad_targets}. Choices: "
            f"{list(_TARGET_FACTORIES)}",
            file=sys.stderr,
        )
        return 2
    bad_conditions = [
        c for c in condition_tokens if c not in _CONDITION_FACTORIES
    ]
    if bad_conditions:
        print(
            f"unknown condition(s): {bad_conditions}. Choices: "
            f"{list(_CONDITION_FACTORIES)}",
            file=sys.stderr,
        )
        return 2
    if not target_tokens:
        print("--target cannot be empty", file=sys.stderr)
        return 2
    if not condition_tokens:
        print("--conditions cannot be empty", file=sys.stderr)
        return 2
    if args.n < 1:
        print("--n must be positive", file=sys.stderr)
        return 2
    if args.replicates < 1:
        print("--replicates must be positive", file=sys.stderr)
        return 2

    model_pool = tuple(_parse_csv(args.model_pool))
    if not model_pool:
        print("--model-pool cannot be empty", file=sys.stderr)
        return 2

    targets = [
        dataclasses.replace(
            _TARGET_FACTORIES[t](),
            model_pool=model_pool,
        )
        for t in target_tokens
    ]
    # ConditionConfig factories validate n at call time (e.g.
    # single_round / multi_round require n>=2). Let the ValueError
    # propagate as a user-facing error before any LLM cost.
    try:
        conditions = [
            _CONDITION_FACTORIES[c](n=args.n) for c in condition_tokens
        ]
    except ValueError as exc:
        print(f"invalid condition config: {exc}", file=sys.stderr)
        return 2

    # Build grader factories per target. Resolve the prose judge LLM
    # once here (rather than per-cell) so we share one client and
    # surface ANTHROPIC_API_KEY-style env errors before the loop.
    # Lazy: only construct the judge LLM when a prose target is
    # actually selected, so code-only runs don't need a judge key.
    grader_factories: dict[str, GraderFactory] = {}
    prose_judge_needed = any(
        t.name == "prose_substrate_thesis" for t in targets
    )
    prose_judge_llm = (
        from_model(args.judge_model) if prose_judge_needed else None
    )
    for target in targets:
        if target.name == "prose_substrate_thesis":
            grader_factories[target.name] = (
                make_prose_substrate_thesis_grader_factory(
                    judge_llm=prose_judge_llm
                )
            )
        elif target.name == "code_leetcode_longest_substring":
            grader_factories[target.name] = (
                make_leetcode_longest_substring_grader_factory()
            )
        elif target.name == "code_leetcode_trapping_rain_water":
            grader_factories[target.name] = (
                make_leetcode_trapping_rain_water_grader_factory()
            )
        elif target.name == "code_leetcode_regex_matching":
            grader_factories[target.name] = (
                make_leetcode_regex_matching_grader_factory()
            )
        else:
            # Unreachable — _TARGET_FACTORIES gates target tokens.
            raise ValueError(
                f"no grader factory for target {target.name!r}"
            )

    print(f"targets:    {[t.name for t in targets]}", flush=True)
    print(f"conditions: {[c.name for c in conditions]}", flush=True)
    print(f"replicates: {args.replicates}", flush=True)
    print(f"model pool: {model_pool}", flush=True)
    print(
        f"judge:      "
        f"{args.judge_model if prose_judge_needed else '(unused)'}",
        flush=True,
    )
    print()

    cells_run = 0
    cells_failed = 0
    failures: list[str] = []
    run_roots: list[Path] = []

    for replicate_idx in range(1, args.replicates + 1):
        run_root = _fresh_run_root()
        run_root.mkdir(parents=True, exist_ok=True)
        run_roots.append(run_root)
        # Shared peer-context store at run-root (not inside any cell
        # dir) so the harness's per-cell agent_memory rmtree doesn't
        # wipe it. All cells in this replicate see the same demo
        # observations — a held-constant operator-mediated input.
        shared_memory_path = run_root / "shared-memory.db"
        peer_context_loader = _build_peer_context_loader(shared_memory_path)

        rep_label = f"[replicate {replicate_idx}/{args.replicates}]"
        print(f"{rep_label} run_root: {run_root}", flush=True)

        for target in targets:
            grader_factory = grader_factories[target.name]
            for condition in conditions:
                cell_dir = run_root / target.name / condition.name
                events_path = cell_dir / "events.jsonl"
                cell_label = f"{target.name} × {condition.name}"
                print(
                    f"{rep_label} starting: {cell_label}",
                    flush=True,
                )
                try:
                    result = await run_cell(
                        target=target,
                        condition=condition,
                        proposer_factory=_proposer_factory,
                        output_dir=run_root,
                        peer_context_loader=peer_context_loader,
                        grader_factory=grader_factory,
                        tracer=StdoutTracer(color=True),
                        emit=_build_event_tee(events_path),
                    )
                except Exception as exc:  # noqa: BLE001
                    cells_failed += 1
                    msg = f"{rep_label} FAILED: {cell_label}: {exc!r}"
                    failures.append(msg)
                    print(msg, flush=True)
                    # Continue: a flaky cell shouldn't sink the grid.
                    continue
                cells_run += 1
                print(
                    f"{rep_label} done:     {cell_label} "
                    f"(scores={len(result.eval_scores)})",
                    flush=True,
                )

    print()
    print("=" * 72)
    print(f"cells run:    {cells_run}")
    print(f"cells failed: {cells_failed}")
    if failures:
        print("failures:")
        for f in failures:
            print(f"  {f}")
    print()
    print("run roots:")
    for r in run_roots:
        print(f"  {r}")
    print("=" * 72)
    return 0 if cells_failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
