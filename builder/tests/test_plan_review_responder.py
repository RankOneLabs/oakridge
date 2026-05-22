"""Tests for plan_review_responder: tool sequence verification with fake LLM."""
from __future__ import annotations

import json
from typing import Any

import pytest
from jig.core.types import LLMClient, LLMResponse, ToolCall, Usage
from pytest_httpx import HTTPXMock
from safir_py import SafirClient

from builder.lib.atom_map import (
    cohort_indices as _cohort_indices,
)
from builder.lib.atom_map import (
    next_cohort_index as _next_cohort_index,
)
from builder.lib.atom_map import (
    parse_edge_keys as _parse_edge_keys,
)
from builder.lib.atom_map import (
    would_create_cycle as _would_create_cycle,
)
from builder.plan_review_responder import (
    AddEdgeTool,
    EditCohortTool,
    ReplyToThreadTool,
    run_plan_review_responder,
)
from builder.review_responder_base import (
    ReviewResponderContext,
    ThreadMessage,
    ThreadSnapshot,
)
from tests.helpers import atom_edit_payload, thread_message_payload

BASE = "http://safir.test"

_USAGE = Usage(input_tokens=100, output_tokens=20, cost=None)


# ---------------------------------------------------------------------------
# FakeLLM
# ---------------------------------------------------------------------------


class FakeLLM(LLMClient):  # type: ignore[misc]
    """Replays a canned sequence of LLMResponses."""

    def __init__(self, responses: list[LLMResponse]) -> None:
        self._responses = iter(responses)

    async def complete(self, params: Any) -> LLMResponse:
        return next(self._responses)


def _tool_response(name: str, args: dict[str, Any], call_id: str = "tc1") -> LLMResponse:
    return LLMResponse(
        content="",
        tool_calls=[ToolCall(id=call_id, name=name, arguments=args)],
        usage=_USAGE,
        latency_ms=0.0,
        model="stub",
    )


def _text_response(text: str = "Done.") -> LLMResponse:
    return LLMResponse(
        content=text,
        tool_calls=None,
        usage=_USAGE,
        latency_ms=0.0,
        model="stub",
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_ctx(atom_map: dict[str, str] | None = None) -> ReviewResponderContext:
    return ReviewResponderContext(
        target_type="plan",
        target_id="plan-1",
        thread_id="thread-1",
        thread=ThreadSnapshot(
            id="thread-1",
            target_type="plan",
            target_id="plan-1",
            anchor="cohorts[0]",
            status="open",
            agent_responding=1,
            created_at="2026-01-01T00:00:00Z",
            messages=[
                ThreadMessage(
                    id="msg-0",
                    thread_id="thread-1",
                    author="operator",
                    body="Please rename cohort 0.",
                    created_at="2026-01-01T00:00:00Z",
                )
            ],
        ),
        atom_map=atom_map
        or {
            "cohorts[0].title": "Old Title",
            "cohorts[0].notes": "Some notes",
            "cohorts[0].priority": "1",
        },
        other_open_threads=[],
        parent_task_notes="Do the thing.",
    )


# ---------------------------------------------------------------------------
# Unit helpers
# ---------------------------------------------------------------------------


def test_cohort_indices() -> None:
    atom_map = {
        "cohorts[0].title": "A",
        "cohorts[1].title": "B",
        "cohorts[3].notes": "C",
        "deps[0,1]": "1",
    }
    assert _cohort_indices(atom_map) == {0, 1, 3}


def test_next_cohort_index_empty() -> None:
    assert _next_cohort_index({}) == 0


def test_next_cohort_index_gap() -> None:
    assert _next_cohort_index({"cohorts[0].title": "A", "cohorts[2].title": "B"}) == 3


def test_parse_edge_keys() -> None:
    atom_map = {"deps[0,1]": "1", "deps[1,2]": "1", "cohorts[0].title": "X"}
    edges = _parse_edge_keys(atom_map)
    assert edges == {(0, 1), (1, 2)}


def test_would_create_cycle_self() -> None:
    assert _would_create_cycle(set(), 0, 0) is True


def test_would_create_cycle_no_cycle() -> None:
    edges = {(0, 1), (1, 2)}
    assert _would_create_cycle(edges, 0, 3) is False


def test_would_create_cycle_detects_cycle() -> None:
    edges = {(1, 2), (2, 3)}
    # Adding 3 → 1 would make 1→2→3→1
    assert _would_create_cycle(edges, 3, 1) is True


def test_would_create_cycle_direct() -> None:
    edges = {(0, 1)}
    assert _would_create_cycle(edges, 1, 0) is True


# ---------------------------------------------------------------------------
# Tool tests via fake safir
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_edit_cohort_tool_posts_correct_body(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/plan/plan-1/edits",
        json=atom_edit_payload(id='edit-1', anchor='cohorts[0].title', new_value='New Title'),
    )
    ctx = _make_ctx()
    client = SafirClient(base_url=BASE)
    tool = EditCohortTool(ctx, client)
    result_json = await tool.execute({
        "cohort_index": 0,
        "updates": {"title": "New Title"},
        "prev_values": {"title": "Old Title"},
    })
    result = json.loads(result_json)
    assert result["edits"][0]["edit_id"] == "edit-1"
    req = httpx_mock.get_requests()[0]
    body = json.loads(req.content)
    assert body["anchor"] == "cohorts[0].title"
    assert body["new_value"] == "New Title"
    assert body["prev_value"] == "Old Title"
    assert body["thread_id"] == "thread-1"
    await client.aclose()


@pytest.mark.asyncio
async def test_edit_cohort_tool_missing_cohort(httpx_mock: HTTPXMock) -> None:
    ctx = _make_ctx()
    client = SafirClient(base_url=BASE)
    tool = EditCohortTool(ctx, client)
    result_json = await tool.execute({
        "cohort_index": 99,
        "updates": {"title": "X"},
        "prev_values": {},
    })
    result = json.loads(result_json)
    assert "error" in result
    await client.aclose()


@pytest.mark.asyncio
async def test_add_edge_tool_cycle_rejected(httpx_mock: HTTPXMock) -> None:
    atom_map = {
        "cohorts[0].title": "A",
        "cohorts[1].title": "B",
        "deps[0,1]": "1",
    }
    ctx = _make_ctx(atom_map=atom_map)
    client = SafirClient(base_url=BASE)
    tool = AddEdgeTool(ctx, client)
    result_json = await tool.execute({"from_index": 1, "to_index": 0})
    result = json.loads(result_json)
    assert "cycle" in result["error"]
    await client.aclose()


@pytest.mark.asyncio
async def test_reply_to_thread_tool(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/threads/thread-1/messages",
        json=thread_message_payload(id='msg-1', body='I did the thing.'),
    )
    ctx = _make_ctx()
    client = SafirClient(base_url=BASE)
    tool = ReplyToThreadTool(ctx, client)
    result_json = await tool.execute({"body": "I did the thing."})
    result = json.loads(result_json)
    assert result["reply_message_id"] == "msg-1"
    assert ctx.reply_message_id == "msg-1"
    await client.aclose()


# ---------------------------------------------------------------------------
# Full agent run with fake LLM
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_plan_review_responder_edit_and_reply(httpx_mock: HTTPXMock) -> None:
    """Agent calls EditCohortTool then ReplyToThreadTool; verifies POST sequence."""
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/plan/plan-1/edits",
        json=atom_edit_payload(id='edit-1', anchor='cohorts[0].title'),
    )
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/threads/thread-1/messages",
        json=thread_message_payload(id='msg-1', body='Renamed cohort 0.'),
    )

    fake_llm = FakeLLM([
        _tool_response(
            "EditCohortTool",
            {
                "cohort_index": 0,
                "updates": {"title": "New Title"},
                "prev_values": {"title": "Old Title"},
            },
            call_id="tc1",
        ),
        _tool_response(
            "ReplyToThreadTool",
            {"body": "I renamed cohort 0 to 'New Title'."},
            call_id="tc2",
        ),
        _text_response("Done."),
    ])

    ctx = _make_ctx()
    client = SafirClient(base_url=BASE)
    result = await run_plan_review_responder(ctx=ctx, client=client, _llm_override=fake_llm)
    await client.aclose()

    assert result.status == "completed"
    assert result.reply_message_id == "msg-1"
    assert result.conflicts == []

    requests = httpx_mock.get_requests()
    assert len(requests) == 2

    edit_req = requests[0]
    assert "/atoms/plan/plan-1/edits" in str(edit_req.url)
    edit_body = json.loads(edit_req.content)
    assert edit_body["anchor"] == "cohorts[0].title"
    assert edit_body["new_value"] == "New Title"
    assert edit_body["prev_value"] == "Old Title"

    reply_req = requests[1]
    assert "/threads/thread-1/messages" in str(reply_req.url)


@pytest.mark.asyncio
async def test_run_plan_review_responder_no_reply_posts_synthetic(
    httpx_mock: HTTPXMock,
) -> None:
    """Agent that never calls ReplyToThreadTool gets a synthetic reply posted."""
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/threads/thread-1/messages",
        json=thread_message_payload(id='synth-1', body='agent terminated without a reply; consult logs'),
    )

    fake_llm = FakeLLM([_text_response("Forgot to reply.")])

    ctx = _make_ctx()
    client = SafirClient(base_url=BASE)
    result = await run_plan_review_responder(ctx=ctx, client=client, _llm_override=fake_llm)
    await client.aclose()

    assert result.status == "failed"
    assert result.reply_message_id == "synth-1"
    assert result.error is not None
