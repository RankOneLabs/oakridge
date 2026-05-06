"""Drive one (target × condition) cell end-to-end against real LLMs.

Hardcoded config — edit the block below to change cell shape, then
re-run:

    cd legit-biz-club
    uv run python scripts/run_one_project.py

Requires ``ANTHROPIC_API_KEY`` (the default model_pool below pins to
Anthropic so one provider key is enough). Switch the pool to mix
providers and you'll need their keys too.

Output goes to ``legit-biz-club/.run/<ISO timestamp>/`` (gitignored).
The cell's artifact lives at
``<output_dir>/<target.name>/<condition.name>/<artifact_filename>``.

This is the v0 "minimalist UX" — terminal only, no kbbl wiring. The
``emit`` callback prints ``[workspace_event]`` lines so we can see
what events kbbl *would* receive once an interface is sketched out.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
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
from legit_biz_club.study.conditions import ensemble_incremental_only
from legit_biz_club.study.runner import run_cell
from legit_biz_club.study.v1_graders import (
    make_prose_substrate_thesis_grader_factory,
)
from legit_biz_club.study.v1_targets import (
    prose_substrate_thesis,
)

# --- config ----------------------------------------------------------

# Pin to Anthropic for cost-conscious smoke runs (one provider key
# suffices). The target's default model_pool spans three providers;
# override here when iterating.
TARGET = dataclasses.replace(
    prose_substrate_thesis(),
    model_pool=("claude-sonnet-4-5", "claude-haiku-4-5"),
)
CONDITION = ensemble_incremental_only(n=2)
GRADER_FACTORY = make_prose_substrate_thesis_grader_factory()
# Switch to leetcode by importing + swapping:
#   from legit_biz_club.study.v1_graders import make_leetcode_longest_substring_grader_factory
#   from legit_biz_club.study.v1_targets import code_leetcode_longest_substring
#   TARGET = dataclasses.replace(
#       code_leetcode_longest_substring(),
#       model_pool=("claude-sonnet-4-5", "claude-haiku-4-5"),
#   )
#   GRADER_FACTORY = make_leetcode_longest_substring_grader_factory()

# Anchor the run dir at the repo's legit-biz-club/ regardless of where
# the script is launched from. UTC + microseconds + trailing 'Z' so
# the directory name aligns with the UTC timestamps in events.jsonl
# (easier post-mortem correlation) AND two same-second launches in
# the edit-and-rerun loop don't silently mix runs into one directory.
_REPO_LBC = Path(__file__).resolve().parent.parent
RUN_ROOT = (
    _REPO_LBC
    / ".run"
    / datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
)
# run_cell builds <output_dir>/<target.name>/<condition.name>/ — we
# precompute that here so the events.jsonl tee writes alongside
# draft.md and commits/.
CELL_DIR = RUN_ROOT / TARGET.name / CONDITION.name


# --- emit ------------------------------------------------------------


def _build_event_tee(
    jsonl_path: Path,
) -> Callable[[str, dict[str, object]], Awaitable[None]]:
    """Build an emit callback that prints AND appends to a JSONL log.

    Live print stays for terminal visibility (``flush=True`` so it
    streams when stdout is a pipe). The JSONL log is the durable
    record — post-mortems shouldn't depend on terminal scrollback.

    Each line: ``{"ts": iso8601, "kind": str, "payload": dict}``.
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


# --- peer context loader ---------------------------------------------


# Hardcoded "prior observations" the demo pre-populates into the
# shared store before run_cell. In a real workflow these would have
# been committed weeks ago by the operator after past projects ended.
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
    """SqliteStore wants an embedder for add(); contents don't matter
    for the loader's metadata-filter path. Zero vector keeps the
    smoke independent of an embedding service."""
    return np.zeros(8, dtype=np.float32)


def _build_peer_context_loader(store_path: Path) -> PeerContextLoader:
    """Return a peer_context_loader that uses the real
    make_sqlite_observation_loader against a stable shared store.

    The first time the loader sees an agent, it pre-populates the
    store with synthetic prior observations attributed to THIS
    runtime agent's id (so the loader's agent_id filter passes).
    Subsequent calls for the same agent just read what's already
    there. Demo-only: in production those observations would have
    been written by MemoryCommitter at the end of past projects.
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


# --- main ------------------------------------------------------------


def _proposer_factory(agent: Agent, *, context: str = "") -> JigProposer:
    return JigProposer(agent, context=context)


async def main() -> None:
    print(f"output dir: {RUN_ROOT}", flush=True)
    print(f"cell dir:   {CELL_DIR}", flush=True)
    # Stable shared store — outside the cell dir so the harness's
    # per-cell rmtree(agent_memory) doesn't wipe it. In production
    # this path would point at a long-lived per-agent store the
    # operator has been writing observations into across projects.
    # Ensure RUN_ROOT exists before constructing SqliteStore: run_cell
    # creates it later, but we open the store path now.
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    shared_memory_path = RUN_ROOT / "shared-memory.db"
    print(f"shared mem: {shared_memory_path}", flush=True)
    peer_context_loader = _build_peer_context_loader(shared_memory_path)
    result = await run_cell(
        target=TARGET,
        condition=CONDITION,
        proposer_factory=_proposer_factory,
        output_dir=RUN_ROOT,
        peer_context_loader=peer_context_loader,
        grader_factory=GRADER_FACTORY,
        tracer=StdoutTracer(color=True),
        emit=_build_event_tee(CELL_DIR / "events.jsonl"),
    )
    print()
    print("=" * 72)
    print(f"cell: {result.target_name} × {result.condition_name}")
    print(f"artifact: {result.artifact_path}")
    print(f"metrics: {result.metrics}")
    if result.eval_scores:
        print()
        print("--- eval scores -----------------------------------------------")
        for s in result.eval_scores:
            print(f"  {s.dimension:32s} {s.value:.3f}  ({s.source.value})")
    print("=" * 72)
    print()
    print("--- final artifact -----------------------------------------------")
    print(result.final_artifact_content)


if __name__ == "__main__":
    asyncio.run(main())
