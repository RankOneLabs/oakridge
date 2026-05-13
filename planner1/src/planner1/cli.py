"""safir-decompose CLI entry."""
from __future__ import annotations

import argparse
import asyncio
import sys

from safir_py import safir_api_token_from_env, safir_base_url_from_env

from .agent import run_planner1
from .safir_client import SafirClient


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="safir-decompose",
        description="Run planner 1 against a safir task; produce a plan of cohorts.",
    )
    p.add_argument("task_id", type=int, help="Safir task id to decompose.")
    p.add_argument("--model", default="claude-opus-4-7", help="LLM model id (jig).")
    p.add_argument("--safir-base-url", default=None, help="Override SAFIR_BASE_URL env.")
    return p


async def _run(args: argparse.Namespace) -> int:
    safir = SafirClient(
        base_url=args.safir_base_url or safir_base_url_from_env(),
        api_token=safir_api_token_from_env(),
    )
    try:
        try:
            task = await safir.get_task(args.task_id)
        except Exception as e:
            print(f"error fetching task {args.task_id}: {e}", file=sys.stderr)
            return 1

        notes = task.get("notes") or ""
        if not notes.strip():
            print(f"task {args.task_id} has no notes; nothing to decompose", file=sys.stderr)
            return 1

        try:
            buffer, summary = await run_planner1(
                parent_task_id=args.task_id,
                task_notes=notes,
                project_id=task["project_id"],
                model=args.model,
            )
        except Exception as e:
            print(f"planner1 run failed: {e}", file=sys.stderr)
            return 2

        if not buffer.cohorts:
            print("planner1 produced an empty plan; not submitting", file=sys.stderr)
            return 3

        payload = buffer.to_payload(summary=summary, model=args.model)
        try:
            result = await safir.submit_plan(args.task_id, payload)
        except Exception as e:
            print(f"safir plan submission failed: {e}", file=sys.stderr)
            return 4

        plan_id = result.get("id")
        if not isinstance(plan_id, str) or not plan_id.strip():
            print(f"safir response missing plan id (got: {result!r})", file=sys.stderr)
            return 5
        print(f"plan_id={plan_id}")
        return 0
    finally:
        await safir.aclose()


def main() -> None:
    args = _build_parser().parse_args()
    sys.exit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
