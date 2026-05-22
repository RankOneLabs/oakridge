"""run_build_pipeline: assemble planner-2 + build_agent into one jig pipeline."""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NotRequired, TypedDict

from jig.core.pipeline import PipelineConfig, PipelineResult, Step, run_pipeline
from jig.tracing.stdout import StdoutTracer
from safir_py import SafirClient, Task

from .build_agent import BuildAgentOutput, run_build_agent
from .errors import (
    BriefNotApprovedError,
    BuildAlreadyStartedError,
    BuilderError,
    ModelsArgError,
    SafirIOError,
)
from .feedback import NoOpFeedback
from .handoff_render import render_from_atom_map
from .planner2 import Planner2Result, run_planner2
from .result import Err, Ok, Result

logger = logging.getLogger(__name__)

_DEFAULT_MODELS = ("claude-opus-4-7", "claude-sonnet-4-6")


class _RunBody(TypedDict):
    executor: str
    status: str
    brief: str
    created_by: str
    permission_profile_id: NotRequired[int]


class _NotDeliveredBody(TypedDict):
    item: str
    reason: str
    notes: str


class _DeviationBody(TypedDict):
    instruction: str
    actual: str
    rationale: str


class _DebriefBody(TypedDict):
    delivered_summary: str
    not_delivered: list[_NotDeliveredBody]
    deviations: list[_DeviationBody]


def parse_models(raw: str | None) -> Result[tuple[str, str], BuilderError]:
    if raw is None:
        return Ok(_DEFAULT_MODELS)
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if len(parts) != 2:
        return Err(
            ModelsArgError(
                op="parse_models",
                entity_id=None,
                detail=(
                    f"--models must yield exactly 2 values (planner2,build); "
                    f"got {len(parts)}"
                ),
            )
        )
    return Ok((parts[0], parts[1]))


async def _resolve_permission_rules(
    safir: SafirClient, permission_profile_id: int | None
) -> Result[dict[str, Any], BuilderError]:
    if permission_profile_id is None:
        return Ok({"allow_all": False, "deny_patterns": []})
    profile = await safir.get_permission_profile(int(permission_profile_id))
    return Ok(profile.rules.model_dump(exclude_none=True))


async def _gather_dep_handoffs(
    safir: SafirClient, task: Task
) -> Result[list[str], BuilderError]:
    out: list[str] = []
    for dep in task.dependencies:
        handoffs = await safir.get_handoffs_for_task(dep.depends_on)
        for h in handoffs:
            if h.raw_markdown:
                out.append(h.raw_markdown)
    return Ok(out)


async def _fetch_parent_spec(
    safir: SafirClient, task: Task
) -> Result[str, BuilderError]:
    if task.parent_id is None:
        return Ok("")
    parent = await safir.get_task(int(task.parent_id))
    return Ok(parent.notes or "")


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _debrief_body(out: BuildAgentOutput) -> _DebriefBody:
    return {
        "delivered_summary": out.delivered_summary,
        "not_delivered": [
            {"item": n.item, "reason": n.reason, "notes": n.notes}
            for n in out.not_delivered
        ],
        "deviations": [
            {"instruction": d.instruction, "actual": d.actual, "rationale": d.rationale}
            for d in out.deviations
        ],
    }


async def run_build_only_pipeline(
    *,
    brief_id: str,
    workdir: Path,
    safir_client: SafirClient,
    permission_profile_id_override: int | None = None,
    dry_run: bool = False,
) -> Result[PipelineResult, BuilderError]:
    """Run only the build-agent phase from an approved build brief.

    Unlike run_build_pipeline (which runs planner-2 first), this entry point
    starts from an already-submitted and approved build brief in safir. It
    skips planner-2 entirely and goes straight to the build agent.
    """
    brief = await safir_client.get_build_brief(brief_id)
    if brief.status != "approved":
        logger.warning(
            "brief %s not approved (status=%r); refusing to start build",
            brief_id,
            brief.status,
        )
        return Err(
            BriefNotApprovedError(
                op="run_build_only_pipeline",
                entity_id=brief_id,
                detail=f"brief status={brief.status!r}, expected 'approved'",
            )
        )

    atom_map = await safir_client.get_atom_map("build_brief", brief_id)
    handoff_raw_markdown = render_from_atom_map(atom_map, brief.model_dump())

    # handoff_docs.run_id is pinned to the latest run; retry path moves the pointer.
    run_data = await safir_client.get_run_by_brief(brief_id)
    run_id = run_data.id
    run_short_id = run_id[:8]
    if any(p.phase_index == 1 for p in run_data.phases):
        logger.warning(
            "build already started on run %s (phase_index=1 exists)", run_id
        )
        return Err(
            BuildAlreadyStartedError(
                op="run_build_only_pipeline",
                entity_id=run_id,
                detail="run already has a build phase (phase_index=1)",
            )
        )

    current_task_id: int | None = (
        int(run_data.task_id) if run_data.task_id is not None else None
    )

    effective_profile_id = (
        permission_profile_id_override
        if permission_profile_id_override is not None
        else run_data.permission_profile_id
    )
    rules_result = await _resolve_permission_rules(safir_client, effective_profile_id)
    match rules_result:
        case Ok(value=permission_rules):
            pass
        case Err(error=err):
            return Err(err)

    phase1_id: str | None = None

    async def build_agent_step(ctx: dict[str, Any]) -> BuildAgentOutput:
        assert phase1_id is not None
        logger.info("dispatching build_agent for run %s", run_short_id)
        output = await run_build_agent(
            handoff_raw_markdown=handoff_raw_markdown,
            workdir=workdir,
            permission_rules=permission_rules,
            current_task_id=current_task_id,
            run_short_id=run_short_id,
            model="claude-sonnet-4-6",
        )
        logger.info(
            "build_agent completed for run %s (pr_urls=%d)",
            run_short_id,
            len(output.pr_urls),
        )
        return output

    config = PipelineConfig(
        name="build-only",
        steps=[] if dry_run else [Step(name="build_agent", fn=build_agent_step)],
        tracer=StdoutTracer(color=False),
        feedback=NoOpFeedback(),
        is_err=lambda r: isinstance(r, dict) and "error" in r,
    )

    # IO edge (d): the outer phase-rollback try/except. Compensates
    # safir phase records when the pipeline body fails, then converts
    # the exception into Err(SafirIOError) so cli.py can render exit code 2.
    try:
        phase1 = await safir_client.create_phase(
            run_id,
            {"phase_index": 1, "target_model": "claude-sonnet-4-6"},
        )
        phase1_id = phase1.id
        logger.info(
            "phase created phase_id=%s phase_index=1 run_id=%s", phase1_id, run_id
        )
        result = await run_pipeline(config, input=brief_id)
    except Exception as exc:
        logger.warning(
            "build-only pipeline body failed for run %s; compensating", run_id
        )
        if phase1_id is not None:
            await safir_client.update_phase(
                phase1_id,
                {"is_terminal": True, "ended_at": _now(), "end_reason": "failed"},
            )
        await safir_client.update_run(run_id, {"status": "failed"})
        return Err(
            SafirIOError(
                op="run_build_only_pipeline",
                entity_id=run_id,
                detail=f"pipeline body failed: {exc}",
            )
        )

    assert phase1_id is not None

    if result.short_circuited or dry_run:
        end_reason = "failed" if result.short_circuited else "completed"
        await safir_client.update_phase(
            phase1_id,
            {"is_terminal": True, "ended_at": _now(), "end_reason": end_reason},
        )
        run_status = "failed" if result.short_circuited else "completed"
        await safir_client.update_run(run_id, {"status": run_status})
        if result.short_circuited:
            logger.warning(
                "build-only pipeline short-circuited at step %r run_id=%s",
                result.error_step,
                run_id,
            )
        else:
            logger.info("dry_run completed for run %s", run_id)
        return Ok(result)

    debrief_out: BuildAgentOutput = result.step_outputs["build_agent"]
    pr_summary = "\n".join(debrief_out.pr_urls) or "(no PRs produced)"
    await safir_client.update_run(run_id, {"result_summary": pr_summary})
    await safir_client.patch_handoff_debrief(
        handoff_id=brief_id,
        debrief=dict(_debrief_body(debrief_out)),
    )
    logger.info(
        "debrief patched on brief %s (pr_urls=%d)", brief_id, len(debrief_out.pr_urls)
    )
    await safir_client.update_phase(
        phase1_id,
        {"is_terminal": True, "ended_at": _now(), "end_reason": "completed"},
    )
    await safir_client.update_run(run_id, {"status": "completed"})
    logger.info("build-only pipeline completed run_id=%s", run_id)
    return Ok(result)


async def run_build_pipeline(
    *,
    child_task_id: int,
    models: tuple[str, str],
    workdir: Path,
    safir_client: SafirClient,
    permission_profile_id_override: int | None = None,
    dry_run: bool = False,
    auto_approve: bool = False,
) -> Result[PipelineResult, BuilderError]:
    task = await safir_client.get_task(child_task_id)
    brief = task.notes or ""

    parent_result = await _fetch_parent_spec(safir_client, task)
    match parent_result:
        case Ok(value=parent_spec):
            pass
        case Err(error=err):
            return Err(err)

    deps_result = await _gather_dep_handoffs(safir_client, task)
    match deps_result:
        case Ok(value=dep_handoffs):
            pass
        case Err(error=err):
            return Err(err)

    run_body: _RunBody = {
        "executor": "jig:planner2+build_agent",
        "status": "running",
        "brief": brief,
        "created_by": "safir-build",
    }
    if permission_profile_id_override is not None:
        run_body["permission_profile_id"] = permission_profile_id_override
    run = await safir_client.create_run(child_task_id, dict(run_body))
    run_id = run.id
    run_short_id = run_id[:8]
    logger.info("run created run_id=%s task_id=%s", run_id, child_task_id)

    phase0_id: str | None = None
    phase1_id: str | None = None
    permission_rules: dict[str, Any] = {"allow_all": False, "deny_patterns": []}

    async def planner2_step(ctx: dict[str, Any]) -> Planner2Result:
        assert phase0_id is not None
        logger.info("dispatching planner2 model=%s phase_id=%s", models[0], phase0_id)
        p2 = await run_planner2(
            brief_markdown=brief,
            parent_spec=parent_spec,
            dep_handoffs_markdown=dep_handoffs,
            phase_id=phase0_id,
            model=models[0],
            safir_client=safir_client,
        )
        logger.info(
            "planner2 completed phase_id=%s handoff_id=%s", phase0_id, p2.handoff_id
        )
        return p2

    async def build_agent_step(ctx: dict[str, Any]) -> BuildAgentOutput:
        assert phase1_id is not None
        p2: Planner2Result = ctx["planner2"]
        logger.info("dispatching build_agent model=%s run_id=%s", models[1], run_id)
        output = await run_build_agent(
            handoff_raw_markdown=p2.raw_markdown,
            workdir=workdir,
            permission_rules=permission_rules,
            current_task_id=child_task_id,
            run_short_id=run_short_id,
            model=models[1],
        )
        logger.info(
            "build_agent completed run_id=%s pr_urls=%d", run_id, len(output.pr_urls)
        )
        return output

    # planner2-only when dry_run OR when not auto_approve (default: stop for review)
    planner2_only = dry_run or not auto_approve
    steps: list[Step] = [Step(name="planner2", fn=planner2_step)]
    if not planner2_only:
        steps.append(Step(name="build_agent", fn=build_agent_step))

    config = PipelineConfig(
        name="builder",
        steps=steps,
        tracer=StdoutTracer(color=False),
        feedback=NoOpFeedback(),
        is_err=lambda r: isinstance(r, dict) and "error" in r,
    )

    # IO edge (d): the outer phase-rollback try/except. Compensates
    # safir phase records when the pipeline body fails, then converts
    # the exception into Err(SafirIOError) so cli.py can render exit code 2.
    try:
        phase0 = await safir_client.create_phase(run_id, {"target_model": models[0]})
        phase0_id = phase0.id
        logger.info(
            "phase created phase_id=%s phase_index=0 run_id=%s", phase0_id, run_id
        )
        if not planner2_only:
            phase1 = await safir_client.create_phase(
                run_id, {"target_model": models[1]}
            )
            phase1_id = phase1.id
            logger.info(
                "phase created phase_id=%s phase_index=1 run_id=%s", phase1_id, run_id
            )
        rules_result = await _resolve_permission_rules(
            safir_client, run.permission_profile_id
        )
        match rules_result:
            case Ok(value=resolved):
                permission_rules = resolved
            case Err(error=err):
                return Err(err)
        result = await run_pipeline(config, input=child_task_id)
    except Exception as exc:
        logger.warning(
            "build pipeline body failed for run %s; compensating", run_id
        )
        if phase0_id is not None:
            await safir_client.update_phase(
                phase0_id,
                {"is_terminal": True, "ended_at": _now(), "end_reason": "failed"},
            )
        if phase1_id is not None:
            await safir_client.update_phase(
                phase1_id,
                {"is_terminal": True, "ended_at": _now(), "end_reason": "failed"},
            )
        await safir_client.update_run(run_id, {"status": "failed"})
        return Err(
            SafirIOError(
                op="run_build_pipeline",
                entity_id=run_id,
                detail=f"pipeline body failed: {exc}",
            )
        )
    assert phase0_id is not None

    if result.short_circuited:
        phase0_reason = "failed" if result.error_step == "planner2" else "completed"
        await safir_client.update_phase(
            phase0_id,
            {"is_terminal": True, "ended_at": _now(), "end_reason": phase0_reason},
        )
        if phase1_id is not None:
            await safir_client.update_phase(
                phase1_id,
                {"is_terminal": True, "ended_at": _now(), "end_reason": "failed"},
            )
        await safir_client.update_run(run_id, {"status": "failed"})
        logger.warning(
            "build pipeline short-circuited at step %r run_id=%s",
            result.error_step,
            run_id,
        )
        return Ok(result)

    await safir_client.update_phase(
        phase0_id,
        {"is_terminal": True, "ended_at": _now(), "end_reason": "completed"},
    )
    logger.info(
        "phase transitioned phase_id=%s end_reason=completed run_id=%s",
        phase0_id,
        run_id,
    )

    if dry_run:
        await safir_client.update_run(run_id, {"status": "completed"})
        logger.info("dry_run completed run_id=%s", run_id)
        return Ok(result)

    if not auto_approve:
        await safir_client.update_run(run_id, {"status": "awaiting_review"})
        logger.info("awaiting_review gate reached run_id=%s", run_id)
        return Ok(result)

    assert phase1_id is not None

    debrief_out: BuildAgentOutput = result.step_outputs["build_agent"]
    pr_summary = "\n".join(debrief_out.pr_urls) or "(no PRs produced)"
    await safir_client.update_run(run_id, {"result_summary": pr_summary})
    p2_result: Planner2Result = result.step_outputs["planner2"]
    await safir_client.patch_handoff_debrief(
        handoff_id=p2_result.handoff_id,
        debrief=dict(_debrief_body(debrief_out)),
    )
    logger.info(
        "debrief patched handoff_id=%s pr_urls=%d",
        p2_result.handoff_id,
        len(debrief_out.pr_urls),
    )
    await safir_client.update_phase(
        phase1_id,
        {"is_terminal": True, "ended_at": _now(), "end_reason": "completed"},
    )
    await safir_client.update_run(run_id, {"status": "completed"})
    logger.info("build pipeline completed run_id=%s", run_id)
    return Ok(result)
