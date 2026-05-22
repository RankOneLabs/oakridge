"""Tests for SafirClient review API methods (get_plan, get_atom_map, etc.)."""
from __future__ import annotations

import json

import httpx
import pydantic
import pytest
from pytest_httpx import HTTPXMock

from safir_py import (
    AgentResponseAck,
    AtomEdit,
    BuildBrief,
    Plan,
    Run,
    SafirAtomEditConflict,
    SafirClient,
    Thread,
    ThreadMessage,
)

BASE = "http://safir.test"


# ---------------------------------------------------------------------------
# Payload factories
# ---------------------------------------------------------------------------


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


def make_build_brief_payload(**overrides: object) -> dict[str, object]:
    payload = make_handoff_payload()
    payload.update(
        {
            "task_id": 42,
            "status": "pending_approval",
            "rejection_reason": None,
            "predecessor_build_brief_id": None,
        }
    )
    payload.update(overrides)
    return payload


def make_atom_edit_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "edit-1",
        "target_type": "plan",
        "target_id": "plan-1",
        "anchor": "cohorts[0].title",
        "prev_value": "Old",
        "new_value": "Updated",
        "edited_by": "u1",
        "thread_id": None,
        "created_at": "2026-01-01T00:00:00Z",
    }
    payload.update(overrides)
    return payload


def make_thread_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "thread-1",
        "target_type": "plan",
        "target_id": "plan-1",
        "anchor": "cohorts[0]",
        "status": "open",
        "agent_responding": 1,
        "resolved_at": None,
        "created_at": "2026-01-01T00:00:00Z",
        "messages": [],
    }
    payload.update(overrides)
    return payload


def make_thread_message_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "msg-1",
        "thread_id": "thread-1",
        "author": "agent",
        "body": "Done!",
        "related_edit_id": None,
        "created_at": "2026-01-01T00:00:00Z",
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def client() -> SafirClient:
    return SafirClient(base_url=BASE)


# ---------------------------------------------------------------------------
# get_plan
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_plan(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/plans/plan-1",
        json=make_plan_payload(),
    )
    result = await client.get_plan("plan-1")
    assert isinstance(result, Plan)
    assert result.id == "plan-1"
    assert result.parent_task_id == 42
    await client.aclose()


# ---------------------------------------------------------------------------
# get_build_brief / get_run_by_brief
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_build_brief(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/build-briefs/hoff-1",
        json=make_build_brief_payload(id="hoff-1"),
    )
    result = await client.get_build_brief("hoff-1")
    assert isinstance(result, BuildBrief)
    assert result.id == "hoff-1"
    assert result.task_id == 42
    assert result.status == "pending_approval"
    await client.aclose()


@pytest.mark.asyncio
async def test_get_run_by_brief(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/build-briefs/hoff-1/run",
        json=make_run_payload(),
    )
    result = await client.get_run_by_brief("hoff-1")
    assert isinstance(result, Run)
    assert result.id == "run-1"
    await client.aclose()


# ---------------------------------------------------------------------------
# get_atom_map — bare dict pass-through
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_atom_map(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    atom_map = {"cohorts[0].title": "First Cohort", "cohorts[0].priority": "1"}
    httpx_mock.add_response(
        url=f"{BASE}/atoms/plan/plan-1",
        json=atom_map,
    )
    result = await client.get_atom_map("plan", "plan-1")
    assert result == atom_map
    await client.aclose()


# ---------------------------------------------------------------------------
# get_thread / list_open_threads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_thread(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/threads/thread-1",
        json=make_thread_payload(),
    )
    result = await client.get_thread("thread-1")
    assert isinstance(result, Thread)
    assert result.id == "thread-1"
    assert result.status == "open"
    await client.aclose()


@pytest.mark.asyncio
async def test_list_open_threads(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/artifacts/plan/plan-1/threads?status=open",
        json=[
            make_thread_payload(id="thread-1"),
            make_thread_payload(id="thread-2", anchor=None),
        ],
    )
    result = await client.list_open_threads("plan", "plan-1")
    assert len(result) == 2
    assert all(isinstance(t, Thread) for t in result)
    assert result[0].id == "thread-1"
    assert result[1].anchor is None
    await client.aclose()


# ---------------------------------------------------------------------------
# post_atom_edit — success
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_atom_edit_success(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/plan/plan-1/edits",
        json=make_atom_edit_payload(),
        status_code=200,
    )
    result = await client.post_atom_edit(
        "plan",
        "plan-1",
        {"anchor": "cohorts[0].title", "new_value": "Updated", "prev_value": "Old"},
    )
    assert isinstance(result, AtomEdit)
    assert result.id == "edit-1"
    assert result.new_value == "Updated"
    request = httpx_mock.get_requests()[0]
    body = json.loads(request.content)
    assert body["anchor"] == "cohorts[0].title"
    assert body["new_value"] == "Updated"
    await client.aclose()


# ---------------------------------------------------------------------------
# post_atom_edit — 409 stale_prev_value raises SafirAtomEditConflict
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_atom_edit_409_conflict(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/plan/plan-1/edits",
        json={
            "error": "stale_prev_value",
            "current_value": "New Concurrent Value",
            "latest_edit_id": "edit-99",
            "edited_by": "user-x",
            "created_at": "2026-01-01T00:01:00Z",
        },
        status_code=409,
    )
    with pytest.raises(SafirAtomEditConflict) as exc_info:
        await client.post_atom_edit(
            "plan", "plan-1", {"anchor": "a", "new_value": "x", "prev_value": "old"}
        )
    exc = exc_info.value
    assert exc.current_value == "New Concurrent Value"
    assert exc.latest_edit_id == "edit-99"
    assert exc.edited_by == "user-x"
    await client.aclose()


@pytest.mark.asyncio
async def test_post_atom_edit_409_null_current_value(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/plan/plan-1/edits",
        json={
            "error": "stale_prev_value",
            "current_value": None,
            "latest_edit_id": "edit-0",
            "edited_by": "system",
            "created_at": "2026-01-01T00:00:00Z",
        },
        status_code=409,
    )
    with pytest.raises(SafirAtomEditConflict) as exc_info:
        await client.post_atom_edit(
            "plan", "plan-1", {"anchor": "a", "new_value": "x", "prev_value": "old"}
        )
    assert exc_info.value.current_value is None
    await client.aclose()


@pytest.mark.asyncio
async def test_post_atom_edit_409_non_stale_raises_http_error(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    """A 409 with a different error body should propagate as HTTPStatusError."""
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/plan/plan-1/edits",
        json={"error": "other_conflict"},
        status_code=409,
    )
    with pytest.raises(httpx.HTTPStatusError):
        await client.post_atom_edit(
            "plan", "plan-1", {"anchor": "a", "new_value": "x", "prev_value": "old"}
        )
    await client.aclose()


# ---------------------------------------------------------------------------
# post_thread_message
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_thread_message(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/threads/thread-1/messages",
        json=make_thread_message_payload(body="Done!"),
        status_code=201,
    )
    result = await client.post_thread_message("thread-1", {"body": "Done!"})
    assert isinstance(result, ThreadMessage)
    assert result.id == "msg-1"
    assert result.body == "Done!"
    request = httpx_mock.get_requests()[0]
    body = json.loads(request.content)
    assert body["body"] == "Done!"
    await client.aclose()


# ---------------------------------------------------------------------------
# post_agent_response
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_agent_response_completed(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/threads/thread-1/agent-response",
        json={"ok": True},
    )
    result = await client.post_agent_response(
        "thread-1", "completed", reply_message_id="msg-1"
    )
    assert isinstance(result, AgentResponseAck)
    assert result.ok is True
    request = httpx_mock.get_requests()[0]
    body = json.loads(request.content)
    assert body["status"] == "completed"
    assert body["reply_message_id"] == "msg-1"
    assert "error" not in body
    await client.aclose()


@pytest.mark.asyncio
async def test_post_agent_response_failed(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/threads/thread-1/agent-response",
        json={"ok": True},
    )
    await client.post_agent_response(
        "thread-1", "failed", error="subprocess crashed"
    )
    request = httpx_mock.get_requests()[0]
    body = json.loads(request.content)
    assert body["status"] == "failed"
    assert body["error"] == "subprocess crashed"
    assert "reply_message_id" not in body
    await client.aclose()


# ---------------------------------------------------------------------------
# Parse-or-raise: review-surface ValidationError at the boundary.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_plan_malformed_payload_raises_validation_error(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/plans/plan-1",
        json={"id": "plan-1"},
    )
    with pytest.raises(pydantic.ValidationError):
        await client.get_plan("plan-1")
    await client.aclose()
