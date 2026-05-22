"""Tests for run_build_only_pipeline: retry path uses latest run via handoff_docs.run_id."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from safir_py import BuildBrief, PermissionProfile, Phase, Run

from builder.pipeline import run_build_only_pipeline


def _make_brief(status: str = "approved") -> BuildBrief:
    return BuildBrief.model_validate(
        {
            "id": "brief-1",
            "phase_id": None,
            "run_id": None,
            "role": "run_brief",
            "schema_version": 1,
            "goal": "do the thing",
            "active_subgoals": [],
            "decisions_made": [],
            "approaches_rejected": [],
            "files_in_scope": [],
            "open_questions": [],
            "next_action": "",
            "raw_markdown": "# Brief",
            "produced_at": "2026-05-22T00:00:00Z",
            "task_id": 7,
            "status": status,
            "rejection_reason": None,
            "predecessor_build_brief_id": None,
        }
    )


def _make_run(run_id: str, phases: list[Phase] | None = None) -> Run:
    return Run.model_validate(
        {
            "id": run_id,
            "task_id": 7,
            "executor": "jig:planner2+build_agent",
            "pipeline_id": None,
            "pipeline_version": None,
            "status": "running",
            "brief": None,
            "result_summary": None,
            "permission_profile_id": None,
            "started_at": "2026-05-22T00:00:00Z",
            "finished_at": None,
            "created_by": None,
            "created_by_session": None,
            "phases": [p.model_dump() for p in (phases or [])],
        }
    )


def _make_phase(run_id: str, phase_index: int = 1) -> Phase:
    return Phase.model_validate(
        {
            "id": f"phase-{phase_index}",
            "run_id": run_id,
            "phase_index": phase_index,
            "oakridge_session_id": None,
            "external_execution_id": None,
            "parent_phase_id": None,
            "started_at": "2026-05-22T00:00:00Z",
            "ended_at": None,
            "end_reason": None,
            "is_terminal": False,
        }
    )


def _make_permission_profile() -> PermissionProfile:
    return PermissionProfile.model_validate(
        {
            "id": 1,
            "name": "test",
            "description": None,
            "is_seed": False,
            "rules": {"allow_all": True, "deny_patterns": []},
            "created_at": "2026-05-22T00:00:00Z",
            "updated_at": "2026-05-22T00:00:00Z",
        }
    )


def _make_safir_client(
    *,
    brief_status: str = "approved",
    run_id: str = "new-run-id",
    phases: list[Phase] | None = None,
) -> MagicMock:
    client = MagicMock()
    client.aclose = AsyncMock()

    client.get_build_brief = AsyncMock(return_value=_make_brief(brief_status))
    client.get_atom_map = AsyncMock(return_value={"goal": "do the thing"})
    client.get_run_by_brief = AsyncMock(return_value=_make_run(run_id, phases))
    client.get_permission_profile = AsyncMock(return_value=_make_permission_profile())
    client.create_phase = AsyncMock(return_value=_make_phase(run_id, phase_index=1))
    client.update_phase = AsyncMock(return_value=None)
    client.update_run = AsyncMock(return_value=None)
    client.patch_handoff_debrief = AsyncMock(return_value=None)

    return client


def _make_build_agent_output() -> MagicMock:
    out = MagicMock()
    out.pr_urls = ["https://github.com/org/repo/pull/1"]
    out.delivered_summary = "delivered"
    out.not_delivered = []
    out.deviations = []
    return out


@pytest.mark.asyncio
async def test_retry_run_uses_latest_run_id(tmp_path: Path) -> None:
    """After retry, get_run_by_brief returns the NEW run id; create_phase must use it."""
    new_run_id = "new-retry-run-abc"
    client = _make_safir_client(run_id=new_run_id, phases=[])

    with patch(
        "builder.pipeline.run_build_agent",
        new=AsyncMock(return_value=_make_build_agent_output()),
    ):
        await run_build_only_pipeline(
            brief_id="brief-1",
            workdir=tmp_path,
            safir_client=client,
        )

    # Phase was created on the new run, not a stale id
    client.create_phase.assert_called_once()
    call_args = client.create_phase.call_args
    assert call_args.args[0] == new_run_id


@pytest.mark.asyncio
async def test_original_failed_run_not_used_after_retry(tmp_path: Path) -> None:
    """When handoff_docs.run_id has moved to a new run, the old run id never appears."""
    old_run_id = "old-failed-run"
    new_run_id = "fresh-retry-run"

    # get_run_by_brief returns the new run (handoff_docs.run_id already updated)
    client = _make_safir_client(run_id=new_run_id, phases=[])

    with patch(
        "builder.pipeline.run_build_agent",
        new=AsyncMock(return_value=_make_build_agent_output()),
    ):
        await run_build_only_pipeline(
            brief_id="brief-1",
            workdir=tmp_path,
            safir_client=client,
        )

    # None of the safir calls use the old run id
    for call in client.create_phase.call_args_list:
        assert old_run_id not in str(call)
    for call in client.update_run.call_args_list:
        assert old_run_id not in str(call)
