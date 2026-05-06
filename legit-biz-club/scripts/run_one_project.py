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
import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

from jig.tracing.stdout import StdoutTracer

from legit_biz_club import Agent, JigProposer
from legit_biz_club.study.conditions import ensemble_incremental_only
from legit_biz_club.study.runner import run_cell
from legit_biz_club.study.targets import prose_target

# --- config ----------------------------------------------------------

TARGET = prose_target(
    seed_content="",
    model_pool=("claude-sonnet-4-5", "claude-haiku-4-5"),
)
CONDITION = ensemble_incremental_only(n=2)

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


# --- main ------------------------------------------------------------


def _proposer_factory(agent: Agent) -> JigProposer:
    return JigProposer(agent)


async def main() -> None:
    print(f"output dir: {RUN_ROOT}", flush=True)
    print(f"cell dir:   {CELL_DIR}", flush=True)
    result = await run_cell(
        target=TARGET,
        condition=CONDITION,
        proposer_factory=_proposer_factory,
        output_dir=RUN_ROOT,
        tracer=StdoutTracer(color=True),
        emit=_build_event_tee(CELL_DIR / "events.jsonl"),
    )
    print()
    print("=" * 72)
    print(f"cell: {result.target_name} × {result.condition_name}")
    print(f"artifact: {result.artifact_path}")
    print(f"metrics: {result.metrics}")
    print("=" * 72)
    print()
    print("--- final artifact -----------------------------------------------")
    print(result.final_artifact_content)


if __name__ == "__main__":
    asyncio.run(main())
