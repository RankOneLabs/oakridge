"""run_build_pipeline: assemble planner-2 + build_agent into one jig pipeline."""
from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jig.core.pipeline import PipelineConfig, PipelineResult, Step, run_pipeline
from jig.tracing.stdout import StdoutTracer
from safir_py import SafirClient

from .build_agent import BuildAgentOutput, run_build_agent
from .feedback import NoOpFeedback
from .planner2 import Planner2Result, run_planner2

_DEFAULT_MODELS = ("claude-opus-4-7", "claude-sonnet-4-6")


def parse_models(raw: str | None) -> tuple[str, str]:
    if raw is None:
        return _DEFAULT_MODELS
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if len(parts) != 2:
        raise ValueError(
            f"--models must yield exactly 2 values (planner2,build); got {len(parts)}"
        )
    return parts[0], parts[1]


async def _resolve_permission_rules(
    safir: SafirClient, run: dict[str, Any]
) -> dict[str, Any]:
    pid = run.get("permission_profile_id")
    if pid is None:
        return {"allow_all": False, "deny_patterns": []}
    profile = await safir.get_permission_profile(int(pid))
    rules = profile.get("rules") or {}
    if not isinstance(rules, dict):
        return {"allow_all": False, "deny_patterns": []}
    return rules


async def _gather_dep_handoffs(
    safir: SafirClient, task: dict[str, Any]
) -> list[str]:
    deps = task.get("dependencies") or []
    if not isinstance(deps, list):
        return []
    out: list[str] = []
    for d in deps:
        dep_id = d.get("depends_on")
        if not isinstance(dep_id, int):
            continue
        handoffs = await safir.get_handoffs_for_task(dep_id)
        for h in handoffs:
            md = h.get("raw_markdown")
            if isinstance(md, str) and md:
                out.append(md)
    return out


async def _fetch_parent_spec(
    safir: SafirClient, task: dict[str, Any]
) -> str:
    pid = task.get("parent_id")
    if pid is None:
        return ""
    parent = await safir.get_task(int(pid))
    return parent.get("notes") or ""


async def run_build_pipeline(
    *,
    child_task_id: int,
    models: tuple[str, str],
    workdir: Path,
    safir_client: SafirClient,
    permission_profile_id_override: int | None = None,
    dry_run: bool = False,
) -> PipelineResult:
    task = await safir_client.get_task(child_task_id)
    brief = task.get("notes") or ""
    parent_spec = await _fetch_parent_spec(safir_client, task)
    dep_handoffs = await _gather_dep_handoffs(safir_client, task)

    run = await safir_client.create_run(
        child_task_id,
        {
            "executor": "jig:planner2+build_agent",
            "status": "running",
            "brief": brief,
            "permission_profile_id": permission_profile_id_override,
            "created_by": "safir-build",
        },
    )
    run_id = run["id"]
    run_short_id = run_id[:8]

    phase0: dict[str, Any] | None = None
    phase1: dict[str, Any] | None = None
    permission_rules: dict[str, Any] = {"allow_all": False, "deny_patterns": []}

    async def planner2_step(ctx: dict[str, Any]) -> Planner2Result:
        assert phase0 is not None
        return await run_planner2(
            brief_markdown=brief,
            parent_spec=parent_spec,
            dep_handoffs_markdown=dep_handoffs,
            phase_id=phase0["id"],
            model=models[0],
            safir_client=safir_client,
        )

    async def build_agent_step(ctx: dict[str, Any]) -> BuildAgentOutput:
        assert phase1 is not None
        p2: Planner2Result = ctx["planner2"]
        return await run_build_agent(
            handoff_raw_markdown=p2.raw_markdown,
            workdir=workdir,
            permission_rules=permission_rules,
            current_task_id=child_task_id,
            run_short_id=run_short_id,
            model=models[1],
        )

    steps: list[Step] = [Step(name="planner2", fn=planner2_step)]
    if not dry_run:
        steps.append(Step(name="build_agent", fn=build_agent_step))

    config = PipelineConfig(
        name="builder",
        steps=steps,
        tracer=StdoutTracer(color=False),
        feedback=NoOpFeedback(),
        is_err=lambda r: isinstance(r, dict) and "error" in r,
    )

    def now() -> str:
        return datetime.now(UTC).isoformat()

    try:
        phase0 = await safir_client.create_phase(run_id, {"target_model": models[0]})
        if not dry_run:
            phase1 = await safir_client.create_phase(run_id, {"target_model": models[1]})
        permission_rules = await _resolve_permission_rules(safir_client, run)
        result = await run_pipeline(config, input=child_task_id)
    except Exception:
        if phase0 is not None:
            await safir_client.update_phase(
                phase0["id"], {"is_terminal": True, "ended_at": now(), "end_reason": "failed"}
            )
        if phase1 is not None:
            await safir_client.update_phase(
                phase1["id"],
                {"is_terminal": True, "ended_at": now(), "end_reason": "failed"},
            )
        await safir_client.update_run(run_id, {"status": "failed"})
        raise
    assert phase0 is not None

    if result.short_circuited:
        await safir_client.update_phase(
            phase0["id"], {"is_terminal": True, "ended_at": now(), "end_reason": "failed"}
        )
        if phase1 is not None:
            await safir_client.update_phase(
                phase1["id"], {"is_terminal": True, "ended_at": now(), "end_reason": "failed"}
            )
        await safir_client.update_run(run_id, {"status": "failed"})
        return result

    await safir_client.update_phase(
        phase0["id"], {"is_terminal": True, "ended_at": now(), "end_reason": "completed"}
    )

    if dry_run:
        await safir_client.update_run(run_id, {"status": "completed"})
        return result

    assert phase1 is not None

    debrief_out: BuildAgentOutput = result.step_outputs["build_agent"]
    pr_summary = "\n".join(debrief_out.pr_urls) or "(no PRs produced)"
    await safir_client.update_run(run_id, {"result_summary": pr_summary})
    p2_result: Planner2Result = result.step_outputs["planner2"]
    await safir_client.patch_handoff_debrief(
        handoff_id=p2_result.handoff_id,
        debrief={
            "delivered_summary": debrief_out.delivered_summary,
            "not_delivered": [
                {
                    "item": n.item,
                    "reason": n.reason,
                    "notes": n.notes,
                }
                for n in debrief_out.not_delivered
            ],
            "deviations": [
                {
                    "instruction": d.instruction,
                    "actual": d.actual,
                    "rationale": d.rationale,
                }
                for d in debrief_out.deviations
            ],
        },
    )
    await safir_client.update_phase(
        phase1["id"], {"is_terminal": True, "ended_at": now(), "end_reason": "completed"}
    )
    await safir_client.update_run(run_id, {"status": "completed"})
    return result
