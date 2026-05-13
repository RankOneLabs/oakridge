"""E2E conflict-surfacing integration tests.

Tests:
  1. plan_review_responder: fake LLM makes 3 tool calls; 2nd returns 409;
     assert (a) no auto-retry, (b) reply body names the conflicted anchor
     and current value, (c) third call on different anchor still posts.
  2. build_brief_review_responder: same pattern.

Uses respx-style httpx mocking via pytest-httpx.
"""
from __future__ import annotations

import json
from typing import Any

import pytest
from pytest_httpx import HTTPXMock

from jig.core.types import LLMClient, LLMResponse, ToolCall, Usage

from safir_py import SafirClient

from builder.review_responder_base import (
    ReviewResponderContext,
    ThreadMessage,
    ThreadSnapshot,
)
from builder.plan_review_responder import run_plan_review_responder
from builder.build_brief_review_responder import run_build_brief_review_responder

BASE = "http://safir.test"
_USAGE = Usage(input_tokens=100, output_tokens=20, cost=None)


# ---------------------------------------------------------------------------
# FakeLLM
# ---------------------------------------------------------------------------


class FakeLLM(LLMClient):  # type: ignore[misc]
    def __init__(self, responses: list[LLMResponse]) -> None:
        self._responses = iter(responses)

    async def complete(self, params: Any) -> LLMResponse:
        return next(self._responses)


def _tool_call(name: str, args: dict[str, Any], cid: str = "tc1") -> LLMResponse:
    return LLMResponse(
        content="",
        tool_calls=[ToolCall(id=cid, name=name, arguments=args)],
        usage=_USAGE,
        latency_ms=0.0,
        model="stub",
    )


def _text(t: str = "Done.") -> LLMResponse:
    return LLMResponse(content=t, tool_calls=None, usage=_USAGE, latency_ms=0.0, model="stub")


# ---------------------------------------------------------------------------
# Plan responder E2E conflict test
# ---------------------------------------------------------------------------


def _plan_ctx() -> ReviewResponderContext:
    return ReviewResponderContext(
        target_type="plan",
        target_id="plan-1",
        thread_id="thread-1",
        thread=ThreadSnapshot(
            id="thread-1",
            target_type="plan",
            target_id="plan-1",
            anchor=None,
            status="open",
            agent_responding=1,
            created_at="2026-01-01T00:00:00Z",
            messages=[
                ThreadMessage(
                    id="m0",
                    thread_id="thread-1",
                    author="op",
                    body="Please edit cohorts 0 and 1.",
                    created_at="2026-01-01T00:00:00Z",
                )
            ],
        ),
        atom_map={
            "cohorts[0].title": "Cohort Zero",
            "cohorts[0].notes": "original notes",
            "cohorts[0].priority": "1",
            "cohorts[1].title": "Cohort One",
            "cohorts[1].notes": "notes one",
            "cohorts[1].priority": "2",
        },
        other_open_threads=[],
        parent_task_notes="Task notes here.",
    )


@pytest.mark.asyncio
async def test_plan_conflict_no_retry_reply_names_conflict_third_call_lands(
    httpx_mock: HTTPXMock,
) -> None:
    """
    Agent makes 3 tool calls:
      1. EditCohortTool on cohorts[0].title → 200 OK
      2. EditCohortTool on cohorts[0].notes → 409 conflict (current="concurrent notes")
      3. EditCohortTool on cohorts[1].title → 200 OK (different anchor, lands)
      4. ReplyToThreadTool → 200 OK

    Asserts:
      (a) Exactly 4 POST /atoms calls, no auto-retry on conflict.
      (b) Reply body contains "cohorts[0].notes" and "concurrent notes".
      (c) Third edit (cohorts[1].title) landed.
    """
    # POST 1: edit cohorts[0].title → 200
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/plan/plan-1/edits",
        json={"id": "e1", "anchor": "cohorts[0].title"},
        status_code=200,
    )
    # POST 2: edit cohorts[0].notes → 409 stale_prev_value
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/plan/plan-1/edits",
        json={
            "error": "stale_prev_value",
            "current_value": "concurrent notes",
            "latest_edit_id": "edit-99",
            "edited_by": "user-x",
            "created_at": "2026-01-01T00:01:00Z",
        },
        status_code=409,
    )
    # POST 3: edit cohorts[1].title → 200
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/plan/plan-1/edits",
        json={"id": "e3", "anchor": "cohorts[1].title"},
        status_code=200,
    )
    # POST 4: reply message
    captured_reply: dict[str, str] = {}
    def capture_reply(request: Any) -> Any:  # noqa: ANN001
        body = json.loads(request.content)
        captured_reply["body"] = body.get("body", "")
        return None

    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/threads/thread-1/messages",
        json={"id": "msg-reply", "body": "Done."},
    )

    # Fake LLM: 3 tool calls + reply, then final text
    fake_llm = FakeLLM([
        _tool_call("EditCohortTool", {
            "cohort_index": 0,
            "updates": {"title": "Updated Zero"},
            "prev_values": {"title": "Cohort Zero"},
        }, "tc1"),
        _tool_call("EditCohortTool", {
            "cohort_index": 0,
            "updates": {"notes": "Updated notes"},
            "prev_values": {"notes": "original notes"},
        }, "tc2"),
        _tool_call("EditCohortTool", {
            "cohort_index": 1,
            "updates": {"title": "Updated One"},
            "prev_values": {"title": "Cohort One"},
        }, "tc3"),
        _tool_call("ReplyToThreadTool", {
            "body": (
                "I edited cohort 0 title and cohort 1 title.\n\n"
                "Conflicts I hit:\n"
                "- cohorts[0].notes: current value is 'concurrent notes' (edit edit-99)"
            ),
        }, "tc4"),
        _text("Done."),
    ])

    ctx = _plan_ctx()
    client = SafirClient(base_url=BASE)
    result = await run_plan_review_responder(ctx=ctx, client=client, _llm_override=fake_llm)
    await client.aclose()

    # (a) No auto-retry: exactly 3 atom edit POSTs (the 409 was not retried)
    atom_requests = [r for r in httpx_mock.get_requests() if "/atoms/" in str(r.url)]
    assert len(atom_requests) == 3, (
        f"expected 3 atom POSTs (no retry on 409), got {len(atom_requests)}"
    )

    # (b) Conflict recorded in result
    assert len(result.conflicts) == 1
    conflict = result.conflicts[0]
    assert conflict.anchor == "cohorts[0].notes"
    assert conflict.current_value == "concurrent notes"
    assert conflict.latest_edit_id == "edit-99"

    # (b) Reply was posted (ReplyToThreadTool was called)
    reply_requests = [r for r in httpx_mock.get_requests() if "/messages" in str(r.url)]
    assert len(reply_requests) == 1
    reply_body_text = json.loads(reply_requests[0].content)["body"]
    assert "cohorts[0].notes" in reply_body_text
    assert "concurrent notes" in reply_body_text

    # (c) Third edit on cohorts[1].title landed
    third_atom = json.loads(atom_requests[2].content)
    assert third_atom["anchor"] == "cohorts[1].title"

    assert result.status == "completed"
    assert result.reply_message_id == "msg-reply"


# ---------------------------------------------------------------------------
# Build brief responder E2E conflict test
# ---------------------------------------------------------------------------


def _brief_ctx() -> ReviewResponderContext:
    return ReviewResponderContext(
        target_type="build_brief",
        target_id="brief-1",
        thread_id="thread-2",
        thread=ThreadSnapshot(
            id="thread-2",
            target_type="build_brief",
            target_id="brief-1",
            anchor="goal",
            status="open",
            agent_responding=1,
            created_at="2026-01-01T00:00:00Z",
            messages=[
                ThreadMessage(
                    id="m0",
                    thread_id="thread-2",
                    author="op",
                    body="Please update goal and decisions.",
                    created_at="2026-01-01T00:00:00Z",
                )
            ],
        ),
        atom_map={
            "goal": "Build the widget",
            "decisions_made[0]": '{"decision":"Use Python","rationale":"familiarity"}',
            "decisions_made[1]": '{"decision":"Use MySQL","rationale":"scalable"}',
        },
        other_open_threads=[],
        parent_task_notes="Notes.",
    )


@pytest.mark.asyncio
async def test_build_brief_conflict_no_retry_reply_names_conflict_third_call_lands(
    httpx_mock: HTTPXMock,
) -> None:
    """
    Agent makes 3 tool calls:
      1. EditAtomTool on goal → 200 OK
      2. EditAtomTool on decisions_made[0] → 409 (current='{"decision":"concurrent"}')
      3. EditAtomTool on decisions_made[1] → 200 OK (different anchor, lands)
      4. ReplyToThreadTool → 200 OK
    """
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/build_brief/brief-1/edits",
        json={"id": "e1"},
        status_code=200,
    )
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/build_brief/brief-1/edits",
        json={
            "error": "stale_prev_value",
            "current_value": '{"decision":"concurrent"}',
            "latest_edit_id": "edit-cc",
            "edited_by": "user-y",
            "created_at": "2026-01-01T00:02:00Z",
        },
        status_code=409,
    )
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/build_brief/brief-1/edits",
        json={"id": "e3"},
        status_code=200,
    )
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/threads/thread-2/messages",
        json={"id": "msg-2"},
    )

    fake_llm = FakeLLM([
        _tool_call("EditAtomTool", {
            "anchor": "goal",
            "new_value": "Build the advanced widget",
            "prev_value": "Build the widget",
        }, "tc1"),
        _tool_call("EditAtomTool", {
            "anchor": "decisions_made[0]",
            "new_value": '{"decision":"Use Go","rationale":"fast"}',
            "prev_value": '{"decision":"Use Python","rationale":"familiarity"}',
        }, "tc2"),
        _tool_call("EditAtomTool", {
            "anchor": "decisions_made[1]",
            "new_value": '{"decision":"Use Postgres","rationale":"reliable"}',
            "prev_value": '{"decision":"Use MySQL","rationale":"scalable"}',
        }, "tc3"),
        _tool_call("ReplyToThreadTool", {
            "body": (
                "Updated goal and decisions_made[1].\n\n"
                "Conflicts I hit:\n"
                "- decisions_made[0]: current value is '{\"decision\":\"concurrent\"}' (edit edit-cc)"
            ),
        }, "tc4"),
        _text("Done."),
    ])

    ctx = _brief_ctx()
    client = SafirClient(base_url=BASE)
    result = await run_build_brief_review_responder(
        ctx=ctx, client=client, _llm_override=fake_llm
    )
    await client.aclose()

    # (a) No auto-retry: exactly 3 atom edit POSTs
    atom_requests = [r for r in httpx_mock.get_requests() if "/atoms/" in str(r.url)]
    assert len(atom_requests) == 3

    # (b) Conflict recorded
    assert len(result.conflicts) == 1
    conflict = result.conflicts[0]
    assert conflict.anchor == "decisions_made[0]"
    assert conflict.current_value == '{"decision":"concurrent"}'

    # (b) Reply was posted and names the conflict
    reply_requests = [r for r in httpx_mock.get_requests() if "/messages" in str(r.url)]
    assert len(reply_requests) == 1
    reply_body_text = json.loads(reply_requests[0].content)["body"]
    assert "decisions_made[0]" in reply_body_text
    assert "concurrent" in reply_body_text

    # (c) Third edit on decisions_made[1] landed
    third_atom = json.loads(atom_requests[2].content)
    assert third_atom["anchor"] == "decisions_made[1]"

    assert result.status == "completed"
    assert result.reply_message_id == "msg-2"
