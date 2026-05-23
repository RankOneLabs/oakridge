"""safir-decompose CLI entry."""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

import httpx
from pydantic import ValidationError
from safir_py import (
    Plan,
    SafirClient,
    SubmitPlanBody,
    Task,
    safir_api_token_from_env,
    safir_base_url_from_env,
)

from .agent import run_planner1
from .errors import (
    EmptyPlanError,
    EmptyTaskNotesError,
    PlannerRunFailedError,
    SafirIOError,
)
from .ids import PlanId, TaskId
from .result import Err, Ok, Result
from .staging import StagingBuffer

logger = logging.getLogger(__name__)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="safir-decompose",
        description="Run planner 1 against a safir task; produce a plan of cohorts.",
    )
    p.add_argument("task_id", type=int, help="Safir task id to decompose.")
    p.add_argument("--model", default="claude-opus-4-7", help="LLM model id (jig).")
    p.add_argument("--safir-base-url", default=None, help="Override SAFIR_BASE_URL env.")
    return p


async def _fetch_task(safir: SafirClient, task_id: TaskId) -> Result[Task, SafirIOError]:
    try:
        task = await safir.get_task(task_id)
    except (httpx.HTTPError, ValidationError) as e:
        logger.exception("get_task failed: task_id=%s", task_id)
        return Err(
            SafirIOError(op_name="get_task", entity_id=task_id, detail=str(e))
        )
    logger.info("fetched task: task_id=%s project_id=%s", task_id, task.project_id)
    return Ok(task)


async def _run_planner(
    *, parent_task_id: TaskId, task_notes: str, project_id: str, model: str
) -> Result[tuple[StagingBuffer, str], PlannerRunFailedError]:
    logger.info(
        "starting planner1 run: parent_task_id=%s project_id=%s model=%s",
        parent_task_id,
        project_id,
        model,
    )
    try:
        buffer, summary = await run_planner1(
            parent_task_id=parent_task_id,
            task_notes=task_notes,
            project_id=project_id,
            model=model,
        )
    except Exception as e:
        logger.exception("planner1 run failed: parent_task_id=%s", parent_task_id)
        return Err(
            PlannerRunFailedError(
                op_name="run_planner1",
                entity_id=parent_task_id,
                detail=str(e),
            )
        )
    logger.info(
        "planner1 run complete: parent_task_id=%s cohorts=%s summary_chars=%s",
        parent_task_id,
        len(buffer.cohorts),
        len(summary),
    )
    return Ok((buffer, summary))


async def _submit_plan(
    safir: SafirClient, parent_task_id: TaskId, body: SubmitPlanBody
) -> Result[Plan, SafirIOError]:
    try:
        plan = await safir.submit_plan(parent_task_id, body)
    except (httpx.HTTPError, ValidationError) as e:
        logger.exception("submit_plan failed: parent_task_id=%s", parent_task_id)
        return Err(
            SafirIOError(
                op_name="submit_plan", entity_id=parent_task_id, detail=str(e)
            )
        )
    logger.info(
        "submitted plan: parent_task_id=%s plan_id=%s cohorts=%s",
        parent_task_id,
        plan.id,
        len(plan.cohorts),
    )
    return Ok(plan)


def _buffer_to_body(
    buffer: StagingBuffer, *, summary: str, model: str
) -> SubmitPlanBody:
    payload = buffer.to_payload(summary=summary, model=model)
    body: SubmitPlanBody = {
        "summary": payload["summary"],
        "model": payload["model"],
        "cohorts": payload["cohorts"],
        "dependencies": payload["dependencies"],
    }
    return body


async def _run(args: argparse.Namespace) -> int:
    task_id = TaskId(args.task_id)
    safir = SafirClient(
        base_url=args.safir_base_url or safir_base_url_from_env(),
        api_token=safir_api_token_from_env(),
    )
    try:
        match await _fetch_task(safir, task_id):
            case Err(fetch_err):
                print(
                    f"error fetching task {task_id}: {fetch_err.detail}",
                    file=sys.stderr,
                )
                return 1
            case Ok(task):
                pass

        notes = task.notes or ""
        if not notes.strip():
            empty_notes = EmptyTaskNotesError(
                op_name="validate_task_notes",
                entity_id=task_id,
                detail="task has no notes; nothing to decompose",
            )
            logger.warning(
                "rejected empty task notes: task_id=%s detail=%s",
                task_id,
                empty_notes.detail,
            )
            print(f"task {task_id} {empty_notes.detail}", file=sys.stderr)
            return 1

        match await _run_planner(
            parent_task_id=task_id,
            task_notes=notes,
            project_id=task.project_id,
            model=args.model,
        ):
            case Err(run_err):
                print(f"planner1 run failed: {run_err.detail}", file=sys.stderr)
                return 2
            case Ok((buffer, summary)):
                pass

        if not buffer.cohorts:
            empty_plan = EmptyPlanError(
                op_name="validate_plan",
                entity_id=task_id,
                detail="planner1 produced an empty plan; not submitting",
            )
            logger.warning(
                "rejected empty plan: task_id=%s detail=%s",
                task_id,
                empty_plan.detail,
            )
            print(empty_plan.detail, file=sys.stderr)
            return 3

        body = _buffer_to_body(buffer, summary=summary, model=args.model)
        match await _submit_plan(safir, task_id, body):
            case Err(submit_err):
                print(
                    f"safir plan submission failed: {submit_err.detail}",
                    file=sys.stderr,
                )
                return 4
            case Ok(plan):
                plan_id = PlanId(plan.id)
                print(f"plan_id={plan_id}")
                return 0
    finally:
        await safir.aclose()


def main() -> None:
    args = _build_parser().parse_args()
    sys.exit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
