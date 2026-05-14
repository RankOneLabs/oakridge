"""Tests for run_build_only_pipeline: retry path uses latest run via handoff_docs.run_id."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from builder.pipeline import run_build_only_pipeline


def _make_safir_client(
    *,
    brief_status: str = "approved",
    run_id: str = "new-run-id",
    phases: list[dict] | None = None,
) -> MagicMock:
    client = MagicMock()
    client.aclose = AsyncMock()

    client.get_build_brief = AsyncMock(
        return_value={"id": "brief-1", "status": brief_status}
    )
    client.get_atom_map = AsyncMock(return_value={"goal": "do the thing"})
    client.get_run_by_brief = AsyncMock(
        return_value={
            "id": run_id,
            "task_id": 7,
            "phases": phases if phases is not None else [],
        }
    )
    client.get_permission_profile = AsyncMock(return_value={"rules": {"allow_all": True, "deny_patterns": []}})
    client.create_phase = AsyncMock(
        return_value={"id": "phase-1", "phase_index": 1, "run_id": run_id}
    )
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
