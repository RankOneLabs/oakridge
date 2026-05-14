"""safir-build CLI entry."""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from safir_py import SafirClient, safir_api_token_from_env, safir_base_url_from_env

from .pipeline import (
    BuildAlreadyStartedError,
    BuildBriefNotApprovedError,
    parse_models,
    run_build_only_pipeline,
    run_build_pipeline,
)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="safir-build",
        description="Run the build pipeline from a safir task or approved build brief.",
    )

    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "task_id",
        nargs="?",
        type=int,
        help="Safir child task id (runs planner-2 + build agent).",
    )
    source.add_argument(
        "--from-brief",
        metavar="BRIEF_ID",
        dest="brief_id",
        default=None,
        help="Run build-only pipeline from an approved build brief id.",
    )

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
        help=(
            "Planner-2 only; produces a brief in pending_approval state. "
            "The default `safir-build <task_id>` already stops after planner-2 — "
            "use this flag only if you also want to skip phase-creation for the build step."
        ),
    )
    p.add_argument(
        "--auto-approve",
        dest="auto_approve",
        action="store_true",
        help=(
            "Skip the build-brief review gate. Run planner-2 then the build agent "
            "in one go (equivalent to spec's bypass-review path)."
        ),
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
        safir = SafirClient(
            base_url=args.safir_base_url or safir_base_url_from_env(),
            api_token=safir_api_token_from_env(),
        )
    except Exception as e:
        print(f"safir client setup failed: {e}", file=sys.stderr)
        return 1

    if args.brief_id is not None and getattr(args, "auto_approve", False):
        print("error: --from-brief and --auto-approve are mutually exclusive", file=sys.stderr)
        return 1

    try:
        if args.brief_id is not None:
            # --from-brief mode: build-only pipeline
            try:
                result = await run_build_only_pipeline(
                    brief_id=args.brief_id,
                    workdir=workdir,
                    safir_client=safir,
                    permission_profile_id_override=args.permission_profile_id,
                    dry_run=args.dry_run,
                )
            except BuildBriefNotApprovedError as e:
                print(f"error: {e}", file=sys.stderr)
                return 4
            except BuildAlreadyStartedError as e:
                print(f"error: {e}", file=sys.stderr)
                return 5
            except Exception as e:
                print(f"build-only pipeline failed: {e}", file=sys.stderr)
                return 2
        else:
            # task_id mode: full planner-2 + build pipeline
            try:
                models = parse_models(args.models)
            except ValueError as e:
                print(f"--models error: {e}", file=sys.stderr)
                return 1
            try:
                result = await run_build_pipeline(
                    child_task_id=args.task_id,
                    models=models,
                    workdir=workdir,
                    safir_client=safir,
                    permission_profile_id_override=args.permission_profile_id,
                    dry_run=args.dry_run,
                    auto_approve=getattr(args, "auto_approve", False),
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

        # When running in the default review-gate mode (no --auto-approve, no --dry-run,
        # no --from-brief), planner-2 has produced a pending brief — tell the operator
        # what to do next.
        auto_approve = getattr(args, "auto_approve", False)
        if args.brief_id is None and not auto_approve and not args.dry_run:
            p2 = result.step_outputs.get("planner2")
            brief_id = getattr(p2, "handoff_id", None) if p2 is not None else None
            if brief_id:
                print(
                    f"Brief ready for review: {brief_id}. "
                    f"Next: review in kbbl PWA, approve, then click 'Run build' "
                    f"OR run safir-build --from-brief {brief_id}."
                )
            return 0

        print(f"pipeline trace_id={result.trace_id}")
        return 0
    finally:
        await safir.aclose()


def main() -> None:
    args = _build_parser().parse_args()
    sys.exit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
