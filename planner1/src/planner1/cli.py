"""safir-plan CLI entry."""
from __future__ import annotations

import argparse
import asyncio
import sys

from .agent import run_planner1
from .kbbl_client import KbblClient, kbbl_base_url_from_env
from .safir_client import SafirClient, safir_api_token_from_env, safir_base_url_from_env
from .staging import StagingBuffer


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="safir-plan",
        description="Run planner 1 against a safir task; decompose into staged child tasks.",
    )
    p.add_argument("task_id", type=int, help="Safir task id to decompose.")
    p.add_argument("--model", default="claude-opus-4-7", help="LLM model id (jig).")
    p.add_argument(
        "--apply",
        action="store_true",
        help="Skip kbbl staging; write tasks + deps directly to safir.",
    )
    p.add_argument("--safir-base-url", default=None, help="Override SAFIR_BASE_URL env.")
    p.add_argument("--kbbl-base-url", default=None, help="Override KBBL_BASE_URL env.")
    return p


async def _apply_directly(safir: SafirClient, buffer: StagingBuffer) -> int:
    parent = await safir.get_task(buffer.parent_task_id)
    project_id = parent["project_id"]
    order = buffer.toposort()
    virtual_to_real: dict[int, int] = {}
    for idx in order:
        t = buffer.tasks[idx]
        created = await safir.create_task(
            {
                "project_id": project_id,
                "parent_id": buffer.parent_task_id,
                "title": t.title,
                "notes": t.notes,
                "priority": t.priority,
            }
        )
        virtual_to_real[t.index] = int(created["id"])
    for dep in buffer.dependencies:
        await safir.add_dependency(
            task_id=virtual_to_real[dep.task_index],
            depends_on=virtual_to_real[dep.depends_on_index],
        )
    print(
        f"applied {len(buffer.tasks)} tasks and {len(buffer.dependencies)} dependencies to safir."
    )
    return 0


async def _run(args: argparse.Namespace) -> int:
    safir = SafirClient(
        base_url=args.safir_base_url or safir_base_url_from_env(),
        api_token=safir_api_token_from_env(),
    )
    try:
        task = await safir.get_task(args.task_id)
    except Exception as e:
        print(f"error fetching task {args.task_id}: {e}", file=sys.stderr)
        await safir.aclose()
        return 1

    notes = task.get("notes") or ""
    if not notes.strip():
        print(f"task {args.task_id} has no notes; nothing to decompose", file=sys.stderr)
        await safir.aclose()
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
        await safir.aclose()
        return 2

    if not buffer.tasks:
        print("planner1 produced an empty decomposition; not submitting", file=sys.stderr)
        await safir.aclose()
        return 3

    if args.apply:
        rc = await _apply_directly(safir, buffer)
        await safir.aclose()
        return rc

    await safir.aclose()
    kbbl = KbblClient(base_url=args.kbbl_base_url or kbbl_base_url_from_env())
    payload = buffer.to_payload(summary=summary, model=args.model)
    try:
        result = await kbbl.submit_proposal(payload)
    except Exception as e:
        print(f"kbbl submission failed: {e}", file=sys.stderr)
        await kbbl.aclose()
        return 4
    await kbbl.aclose()
    pid = result.get("proposal_id") or result.get("id")
    print(f"proposal_id={pid}")
    print(f"review at <kbbl-url>/#proposal={pid}")
    return 0


def main() -> None:
    args = _build_parser().parse_args()
    sys.exit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
