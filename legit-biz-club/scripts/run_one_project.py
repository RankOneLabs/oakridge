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
from datetime import datetime
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
# the script is launched from.
_REPO_LBC = Path(__file__).resolve().parent.parent
RUN_ROOT = _REPO_LBC / ".run" / datetime.now().strftime("%Y-%m-%dT%H-%M-%S")


# --- emit ------------------------------------------------------------


async def _print_event(kind: str, payload: dict[str, object]) -> None:
    """Stand-in for kbbl's workspace-event ingest.

    The kbbl interface for these events is still an open question —
    until we sketch one, surfacing the events to the terminal lets us
    see the shape an operator would consume.
    """
    print(f"[workspace_event] {kind} :: {payload}")


# --- main ------------------------------------------------------------


def _proposer_factory(agent: Agent) -> JigProposer:
    return JigProposer(agent)


async def main() -> None:
    print(f"output dir: {RUN_ROOT}")
    result = await run_cell(
        target=TARGET,
        condition=CONDITION,
        proposer_factory=_proposer_factory,
        output_dir=RUN_ROOT,
        tracer=StdoutTracer(color=True),
        emit=_print_event,
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
