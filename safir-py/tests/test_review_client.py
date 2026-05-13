"""Tests for SafirClient review API methods (get_plan, get_atom_map, etc.)."""
from __future__ import annotations

import json

import httpx
import pytest
from pytest_httpx import HTTPXMock

from safir_py import SafirAtomEditConflict, SafirClient

BASE = "http://safir.test"


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
        json={"id": "plan-1", "parent_task_id": 42, "status": "pending_approval"},
    )
    result = await client.get_plan("plan-1")
    assert result["id"] == "plan-1"
    assert result["parent_task_id"] == 42
    await client.aclose()


# ---------------------------------------------------------------------------
# get_atom_map
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
# get_thread
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_thread(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    thread = {
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
    httpx_mock.add_response(url=f"{BASE}/threads/thread-1", json=thread)
    result = await client.get_thread("thread-1")
    assert result["id"] == "thread-1"
    assert result["status"] == "open"
    await client.aclose()


# ---------------------------------------------------------------------------
# list_open_threads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_open_threads(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/artifacts/plan/plan-1/threads?status=open",
        json=[
            {
                "id": "thread-1",
                "target_type": "plan",
                "target_id": "plan-1",
                "anchor": "cohorts[0]",
                "status": "open",
                "created_at": "2026-01-01T00:00:00Z",
            },
            {
                "id": "thread-2",
                "target_type": "plan",
                "target_id": "plan-1",
                "anchor": None,
                "status": "open",
                "created_at": "2026-01-02T00:00:00Z",
            },
        ],
    )
    result = await client.list_open_threads("plan", "plan-1")
    assert len(result) == 2
    assert result[0]["id"] == "thread-1"
    await client.aclose()


# ---------------------------------------------------------------------------
# post_atom_edit — success
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_atom_edit_success(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    edit_record = {
        "id": "edit-1",
        "anchor": "cohorts[0].title",
        "new_value": "Updated",
        "prev_value": "Old",
    }
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/plan/plan-1/edits",
        json=edit_record,
        status_code=200,
    )
    result = await client.post_atom_edit(
        "plan",
        "plan-1",
        {"anchor": "cohorts[0].title", "new_value": "Updated", "prev_value": "Old"},
    )
    assert result["id"] == "edit-1"
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
async def test_post_thread_message(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    msg = {"id": "msg-1", "thread_id": "thread-1", "author": "agent", "body": "Done!"}
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/threads/thread-1/messages",
        json=msg,
    )
    result = await client.post_thread_message("thread-1", {"body": "Done!"})
    assert result["id"] == "msg-1"
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
    assert result["ok"] is True
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
