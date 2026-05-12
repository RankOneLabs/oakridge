"""safir-build CLI entry."""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from safir_py import SafirClient, safir_api_token_from_env, safir_base_url_from_env

from .pipeline import parse_models, run_build_pipeline


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="safir-build",
        description="Run the planner-2 + build-agent pipeline on a safir task.",
    )
    p.add_argument("task_id", type=int, help="Safir child task id to build.")
    p.add_argument(
        "--models",
        default=None,
        help=(
            "Comma-separated 'planner2,build' models. "
            "Default: claude-opus-4-7,claude-sonnet-4-6."
        ),
    )
    p.add_argument(
        "--workdir",
        default=None,
        help="Working directory (must be an existing git repo). Default: cwd.",
    )
    p.add_argument("--safir-base-url", default=None, help="Override SAFIR_BASE_URL.")
    p.add_argument(
        "--permission-profile-id",
        type=int,
        default=None,
        help="Override the run's permission profile.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Planner-2 only. No build phase, no PRs.",
    )
    return p


async def _run(args: argparse.Namespace) -> int:
    workdir = Path(args.workdir) if args.workdir else Path(os.getcwd())
    workdir = workdir.resolve()
    if not workdir.is_dir():
        print(f"workdir not a directory: {workdir}", file=sys.stderr)
        return 1
    if not (workdir / ".git").exists():
        print(f"workdir is not a git repo (no .git): {workdir}", file=sys.stderr)
        return 1
    try:
        models = parse_models(args.models)
    except ValueError as e:
        print(f"--models error: {e}", file=sys.stderr)
        return 1

    safir = SafirClient(
        base_url=args.safir_base_url or safir_base_url_from_env(),
        api_token=safir_api_token_from_env(),
    )
    try:
        try:
            result = await run_build_pipeline(
                child_task_id=args.task_id,
                models=models,
                workdir=workdir,
                safir_client=safir,
                permission_profile_id_override=args.permission_profile_id,
                dry_run=args.dry_run,
            )
        except Exception as e:
            print(f"build pipeline failed: {e}", file=sys.stderr)
            return 2
        if result.short_circuited:
            print(
                f"pipeline short-circuited at step {result.error_step!r}",
                file=sys.stderr,
            )
            return 3
        print(f"pipeline trace_id={result.trace_id}")
        return 0
    finally:
        await safir.aclose()


def main() -> None:
    args = _build_parser().parse_args()
    sys.exit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
