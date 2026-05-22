"""Tests for SafirClient using pytest-httpx."""
from __future__ import annotations

import json

import httpx
import pydantic
import pytest
from pytest_httpx import HTTPXMock

from safir_py import (
    Handoff,
    PermissionProfile,
    Phase,
    Plan,
    Run,
    SafirClient,
    SubmitPlanBody,
    Task,
)

BASE = "http://safir.test"


# ---------------------------------------------------------------------------
# Fixtures: factory functions that return complete valid wire payloads.
# Per-test overrides keep the literal payload close to the assertion.
# ---------------------------------------------------------------------------


def make_task_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": 42,
        "project_id": "demo",
        "parent_id": None,
        "title": "test",
        "notes": None,
        "status": "backlog",
        "priority": 0,
        "deadline": None,
        "blocked_reason": None,
        "default_permission_profile_id": None,
        "current_run_id": None,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "completed_at": None,
    }
    payload.update(overrides)
    return payload


def make_run_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "run-1",
        "task_id": 42,
        "executor": "jig",
        "pipeline_id": None,
        "pipeline_version": None,
        "status": "running",
        "brief": None,
        "result_summary": None,
        "permission_profile_id": None,
        "started_at": "2026-01-01T00:00:00Z",
        "finished_at": None,
        "created_by": None,
        "created_by_session": None,
    }
    payload.update(overrides)
    return payload


def make_phase_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "ph-1",
        "run_id": "run-1",
        "phase_index": 0,
        "oakridge_session_id": None,
        "external_execution_id": None,
        "parent_phase_id": None,
        "started_at": "2026-01-01T00:00:00Z",
        "ended_at": None,
        "end_reason": None,
        "is_terminal": False,
        "target_model": None,
    }
    payload.update(overrides)
    return payload


def make_handoff_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "hoff-1",
        "phase_id": "ph-1",
        "run_id": "run-1",
        "role": "phase_output",
        "schema_version": 1,
        "goal": None,
        "active_subgoals": None,
        "decisions_made": None,
        "approaches_rejected": None,
        "files_in_scope": None,
        "open_questions": None,
        "next_action": None,
        "raw_markdown": "# hi",
        "produced_at": "2026-01-01T00:00:00Z",
    }
    payload.update(overrides)
    return payload


def make_permission_profile_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": 3,
        "name": "default",
        "description": None,
        "is_seed": True,
        "rules": {
            "auto_approve": [],
            "always_prompt": [],
            "deny": [],
        },
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    payload.update(overrides)
    return payload


def make_plan_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "plan-1",
        "parent_task_id": 42,
        "summary": None,
        "model": None,
        "status": "pending_approval",
        "rejection_reason": None,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "cohorts": [],
        "dependencies": [],
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def client() -> SafirClient:
    return SafirClient(base_url=BASE)


@pytest.fixture
def authed_client() -> SafirClient:
    return SafirClient(base_url=BASE, api_token="xyz")


# ---------------------------------------------------------------------------
# planner1 surface
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_task(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=f"{BASE}/tasks/42", json=make_task_payload())
    result = await client.get_task(42)
    assert isinstance(result, Task)
    assert result.id == 42
    assert result.status == "backlog"
    await client.aclose()


@pytest.mark.asyncio
async def test_create_task(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/tasks",
        json=make_task_payload(id=1, title="new"),
    )
    result = await client.create_task({"title": "new", "project_id": "demo"})
    assert isinstance(result, Task)
    assert result.id == 1
    assert result.title == "new"
    await client.aclose()


@pytest.mark.asyncio
async def test_add_dependency(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST", url=f"{BASE}/tasks/1/dependencies", json={}
    )
    await client.add_dependency(task_id=1, depends_on=2)
    request = httpx_mock.get_requests()[0]
    body = json.loads(request.content)
    assert body == {"depends_on": 2}
    await client.aclose()


@pytest.mark.asyncio
async def test_submit_plan(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    plan_payload = make_plan_payload(
        cohorts=[
            {
                "plan_id": "plan-1",
                "cohort_index": 0,
                "title": "First",
                "notes": "do thing",
                "priority": 1,
                "materialized_task_id": None,
            }
        ],
        dependencies=[],
    )
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/tasks/42/plans",
        json=plan_payload,
        status_code=201,
    )
    body: SubmitPlanBody = {
        "cohorts": [
            {
                "cohort_index": 0,
                "title": "First",
                "notes": "do thing",
                "priority": 1,
            }
        ],
    }
    result = await client.submit_plan(42, body)
    assert isinstance(result, Plan)
    assert result.id == "plan-1"
    assert len(result.cohorts) == 1
    assert result.cohorts[0].title == "First"
    await client.aclose()


# ---------------------------------------------------------------------------
# builder surface
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_handoffs_for_task(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/tasks/42/handoffs",
        json=[make_handoff_payload(id="h1"), make_handoff_payload(id="h2")],
    )
    result = await client.get_handoffs_for_task(42)
    assert len(result) == 2
    assert all(isinstance(h, Handoff) for h in result)
    assert result[0].id == "h1"
    await client.aclose()


@pytest.mark.asyncio
async def test_create_run(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/tasks/42/runs",
        json=make_run_payload(),
        status_code=201,
    )
    result = await client.create_run(42, {"executor": "jig", "status": "running"})
    assert isinstance(result, Run)
    assert result.id == "run-1"
    assert result.status == "running"
    await client.aclose()


@pytest.mark.asyncio
async def test_update_run(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    run_id = "run-abc"
    httpx_mock.add_response(
        method="PATCH",
        url=f"{BASE}/runs/{run_id}",
        json=make_run_payload(id=run_id, status="completed"),
    )
    result = await client.update_run(run_id, {"status": "completed"})
    assert isinstance(result, Run)
    assert result.status == "completed"
    await client.aclose()


@pytest.mark.asyncio
async def test_create_phase(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    run_id = "run-abc"
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/runs/{run_id}/phases",
        json=make_phase_payload(target_model="claude-opus-4-7"),
        status_code=201,
    )
    result = await client.create_phase(run_id, {"target_model": "claude-opus-4-7"})
    assert isinstance(result, Phase)
    assert result.id == "ph-1"
    assert result.target_model == "claude-opus-4-7"
    await client.aclose()


@pytest.mark.asyncio
async def test_update_phase(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    phase_id = "ph-1"
    httpx_mock.add_response(
        method="PATCH",
        url=f"{BASE}/phases/{phase_id}",
        json=make_phase_payload(id=phase_id, is_terminal=True),
    )
    result = await client.update_phase(phase_id, {"is_terminal": True})
    assert isinstance(result, Phase)
    assert result.is_terminal is True
    await client.aclose()


@pytest.mark.asyncio
async def test_submit_phase_handoff_with_parsed(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    phase_id = "ph-2"
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/phases/{phase_id}/handoff",
        json=make_handoff_payload(id="hoff-1", phase_id=phase_id, goal="Y"),
        status_code=201,
    )
    result = await client.submit_phase_handoff(
        phase_id=phase_id, raw_markdown="X", parsed={"goal": "Y"}
    )
    request = httpx_mock.get_requests()[0]
    body = json.loads(request.content)
    assert body["raw_markdown"] == "X"
    assert body["parsed"] == {"goal": "Y"}
    assert isinstance(result, Handoff)
    assert result.id == "hoff-1"
    assert result.goal == "Y"
    await client.aclose()


@pytest.mark.asyncio
async def test_submit_phase_handoff_without_parsed(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    phase_id = "ph-3"
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/phases/{phase_id}/handoff",
        json=make_handoff_payload(id="hoff-2", phase_id=phase_id),
        status_code=201,
    )
    await client.submit_phase_handoff(phase_id=phase_id, raw_markdown="X")
    request = httpx_mock.get_requests()[0]
    body = json.loads(request.content)
    assert "parsed" not in body
    await client.aclose()


@pytest.mark.asyncio
async def test_patch_handoff_debrief(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    handoff_id = "hoff-5"
    debrief = {"delivered_summary": "Z", "not_delivered": [], "deviations": []}
    httpx_mock.add_response(
        method="PATCH",
        url=f"{BASE}/handoffs/{handoff_id}/debrief",
        json=make_handoff_payload(id=handoff_id, debrief=debrief),
    )
    result = await client.patch_handoff_debrief(handoff_id=handoff_id, debrief=debrief)
    request = httpx_mock.get_requests()[0]
    body = json.loads(request.content)
    assert body == {"debrief": debrief}
    assert isinstance(result, Handoff)
    assert result.id == handoff_id
    assert result.debrief is not None
    assert result.debrief.delivered_summary == "Z"
    await client.aclose()


@pytest.mark.asyncio
async def test_get_permission_profile(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/permission-profiles/3",
        json=make_permission_profile_payload(rules={"allow_all": True}),
    )
    result = await client.get_permission_profile(3)
    assert isinstance(result, PermissionProfile)
    assert result.id == 3
    assert result.rules.allow_all is True
    await client.aclose()


# ---------------------------------------------------------------------------
# Auth / headers / error propagation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_auth_header_present(
    authed_client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(url=f"{BASE}/tasks/1", json=make_task_payload(id=1))
    await authed_client.get_task(1)
    request = httpx_mock.get_requests()[0]
    assert request.headers.get("authorization") == "Bearer xyz"
    await authed_client.aclose()


@pytest.mark.asyncio
async def test_no_auth_header_when_no_token(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(url=f"{BASE}/tasks/1", json=make_task_payload(id=1))
    await client.get_task(1)
    request = httpx_mock.get_requests()[0]
    assert "authorization" not in request.headers
    await client.aclose()


@pytest.mark.asyncio
async def test_raise_for_status_on_404(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(url=f"{BASE}/tasks/999", status_code=404)
    with pytest.raises(httpx.HTTPStatusError):
        await client.get_task(999)
    await client.aclose()


# ---------------------------------------------------------------------------
# Parse-or-raise: a malformed payload surfaces as ValidationError at the
# boundary, before the caller ever sees a half-built dict.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_task_malformed_payload_raises_validation_error(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    # Missing every required field. Validation catches it here, not deep in
    # the consumer.
    httpx_mock.add_response(url=f"{BASE}/tasks/42", json={"id": 42, "title": "x"})
    with pytest.raises(pydantic.ValidationError):
        await client.get_task(42)
    await client.aclose()
