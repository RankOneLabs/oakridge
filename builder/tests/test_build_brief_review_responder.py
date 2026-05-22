"""Tests for build_brief_review_responder: tools + delete-shift sequence."""
from __future__ import annotations

import json
from typing import Any

import pytest
from jig.core.types import LLMClient, LLMResponse, ToolCall, Usage
from pytest_httpx import HTTPXMock
from safir_py import SafirClient

from builder.build_brief_review_responder import (
    AppendAtomTool,
    DeleteAtomTool,
    EditAtomTool,
    run_build_brief_review_responder,
)
from builder.lib.atom_map import (
    list_keys as _list_keys,
)
from builder.lib.atom_map import (
    next_list_index as _next_list_index,
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
# FakeLLM (same pattern as plan responder test)
# ---------------------------------------------------------------------------


class FakeLLM(LLMClient):  # type: ignore[misc]
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
    return LLMResponse(content=text, tool_calls=None, usage=_USAGE, latency_ms=0.0, model="stub")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_ctx(atom_map: dict[str, str] | None = None) -> ReviewResponderContext:
    return ReviewResponderContext(
        target_type="build_brief",
        target_id="brief-1",
        thread_id="thread-1",
        thread=ThreadSnapshot(
            id="thread-1",
            target_type="build_brief",
            target_id="brief-1",
            anchor="decisions_made[1]",
            status="open",
            agent_responding=1,
            created_at="2026-01-01T00:00:00Z",
            messages=[
                ThreadMessage(
                    id="msg-0",
                    thread_id="thread-1",
                    author="operator",
                    body="Please delete decision 1.",
                    created_at="2026-01-01T00:00:00Z",
                )
            ],
        ),
        atom_map=atom_map
        or {
            "goal": "Build the widget",
            "decisions_made[0]": '{"decision": "Use Python", "rationale": "familiarity"}',
            "decisions_made[1]": '{"decision": "Use MySQL", "rationale": "scalable"}',
            "decisions_made[2]": '{"decision": "Use Docker", "rationale": "reproducible"}',
            "decisions_made[3]": '{"decision": "Use GitHub", "rationale": "familiar"}',
        },
        other_open_threads=[],
        parent_task_notes="Ship it.",
    )


# ---------------------------------------------------------------------------
# Helper unit tests
# ---------------------------------------------------------------------------


def test_list_keys_ordered() -> None:
    atom_map = {
        "decisions_made[2]": "c",
        "decisions_made[0]": "a",
        "decisions_made[1]": "b",
    }
    assert _list_keys(atom_map, "decisions_made") == [
        "decisions_made[0]",
        "decisions_made[1]",
        "decisions_made[2]",
    ]


def test_next_list_index_empty() -> None:
    assert _next_list_index({}, "active_subgoals") == 0


def test_next_list_index_existing() -> None:
    assert _next_list_index({"active_subgoals[0]": "x", "active_subgoals[2]": "z"}, "active_subgoals") == 3


# ---------------------------------------------------------------------------
# EditAtomTool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_edit_atom_tool(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/build_brief/brief-1/edits",
        json=atom_edit_payload(id='e1', anchor='goal'),
    )
    ctx = _make_ctx()
    client = SafirClient(base_url=BASE)
    tool = EditAtomTool(ctx, client)
    result = json.loads(await tool.execute({
        "anchor": "goal",
        "new_value": "New goal",
        "prev_value": "Build the widget",
    }))
    assert result["edit_id"] == "e1"
    req = httpx_mock.get_requests()[0]
    body = json.loads(req.content)
    assert body["anchor"] == "goal"
    assert body["new_value"] == "New goal"
    assert body["prev_value"] == "Build the widget"
    await client.aclose()


# ---------------------------------------------------------------------------
# AppendAtomTool
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_append_atom_tool(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/build_brief/brief-1/edits",
        json=atom_edit_payload(id='e2', anchor='active_subgoals[0]'),
    )
    ctx = _make_ctx(atom_map={"goal": "x"})  # no active_subgoals yet
    client = SafirClient(base_url=BASE)
    tool = AppendAtomTool(ctx, client)
    result = json.loads(await tool.execute({"field": "active_subgoals", "value": "Step one"}))
    assert result["new_index"] == 0
    assert result["edit_id"] == "e2"
    req = httpx_mock.get_requests()[0]
    body = json.loads(req.content)
    assert body["anchor"] == "active_subgoals[0]"
    assert body["prev_value"] is None
    await client.aclose()


@pytest.mark.asyncio
async def test_append_atom_tool_unknown_field() -> None:
    ctx = _make_ctx()
    client = SafirClient(base_url=BASE)
    tool = AppendAtomTool(ctx, client)
    result = json.loads(await tool.execute({"field": "bogus_field", "value": "x"}))
    assert "error" in result
    await client.aclose()


# ---------------------------------------------------------------------------
# DeleteAtomTool — 4-element list, delete index 1
# This is the canonical test from the build brief spec decision.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_atom_tool_shift_sequence(httpx_mock: HTTPXMock) -> None:
    """
    Delete decisions_made[1] from a 4-element list.
    Expected edit sequence:
      1. DELETE decisions_made[1]   prev_value = snapshot[1]
      2. EDIT   decisions_made[1]   new_value = snapshot[2], prev_value = ""    (just deleted)
      3. EDIT   decisions_made[2]   new_value = snapshot[3], prev_value = snapshot[2]
      4. DELETE decisions_made[3]   prev_value = snapshot[3]
    """
    # 4 responses, one per POST
    for _ in range(4):
        httpx_mock.add_response(
            method="POST",
            url=f"{BASE}/atoms/build_brief/brief-1/edits",
            json=atom_edit_payload(id=f"e-{_}", anchor="x"),
        )

    snapshot = {
        "decisions_made[0]": '{"decision":"D0"}',
        "decisions_made[1]": '{"decision":"D1"}',
        "decisions_made[2]": '{"decision":"D2"}',
        "decisions_made[3]": '{"decision":"D3"}',
    }
    ctx = _make_ctx(atom_map=dict(snapshot))
    client = SafirClient(base_url=BASE)
    tool = DeleteAtomTool(ctx, client)
    result = json.loads(await tool.execute({"anchor": "decisions_made[1]"}))

    assert result["deleted"] == "decisions_made[1]"
    assert result["shifted"] == 2  # elements at [2] and [3] shifted

    requests = httpx_mock.get_requests()
    assert len(requests) == 4

    bodies = [json.loads(r.content) for r in requests]

    # 1. delete decisions_made[1]
    assert bodies[0]["anchor"] == "decisions_made[1]"
    assert bodies[0]["new_value"] == ""
    assert bodies[0]["prev_value"] == snapshot["decisions_made[1]"]

    # 2. shift decisions_made[2] → decisions_made[1]
    assert bodies[1]["anchor"] == "decisions_made[1]"
    assert bodies[1]["new_value"] == snapshot["decisions_made[2]"]
    assert bodies[1]["prev_value"] == ""  # just deleted

    # 3. shift decisions_made[3] → decisions_made[2]
    assert bodies[2]["anchor"] == "decisions_made[2]"
    assert bodies[2]["new_value"] == snapshot["decisions_made[3]"]
    assert bodies[2]["prev_value"] == snapshot["decisions_made[2]"]

    # 4. delete the now-duplicate last element decisions_made[3]
    assert bodies[3]["anchor"] == "decisions_made[3]"
    assert bodies[3]["new_value"] == ""
    assert bodies[3]["prev_value"] == snapshot["decisions_made[3]"]

    await client.aclose()


@pytest.mark.asyncio
async def test_delete_atom_tool_single_element(httpx_mock: HTTPXMock) -> None:
    """Deleting the only element in a list: just one delete, no shift."""
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/build_brief/brief-1/edits",
        json=atom_edit_payload(id='e0'),
    )
    ctx = _make_ctx(atom_map={"active_subgoals[0]": "Only step"})
    client = SafirClient(base_url=BASE)
    tool = DeleteAtomTool(ctx, client)
    result = json.loads(await tool.execute({"anchor": "active_subgoals[0]"}))
    assert result["shifted"] == 0
    assert len(httpx_mock.get_requests()) == 1
    await client.aclose()


@pytest.mark.asyncio
async def test_delete_atom_tool_missing_anchor() -> None:
    ctx = _make_ctx()
    client = SafirClient(base_url=BASE)
    tool = DeleteAtomTool(ctx, client)
    result = json.loads(await tool.execute({"anchor": "decisions_made[99]"}))
    assert "error" in result
    await client.aclose()


@pytest.mark.asyncio
async def test_delete_atom_tool_non_list_anchor() -> None:
    ctx = _make_ctx(atom_map={"goal": "Build"})
    client = SafirClient(base_url=BASE)
    tool = DeleteAtomTool(ctx, client)
    # "goal" doesn't match field[N] pattern
    result = json.loads(await tool.execute({"anchor": "goal"}))
    assert "error" in result
    await client.aclose()


# ---------------------------------------------------------------------------
# Full agent run with fake LLM
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_build_brief_responder_edit_and_reply(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/atoms/build_brief/brief-1/edits",
        json=atom_edit_payload(id='e1'),
    )
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/threads/thread-1/messages",
        json=thread_message_payload(id='msg-1'),
    )

    fake_llm = FakeLLM([
        _tool_response(
            "EditAtomTool",
            {"anchor": "goal", "new_value": "Updated goal", "prev_value": "Build the widget"},
        ),
        _tool_response("ReplyToThreadTool", {"body": "Updated the goal."}),
        _text_response(),
    ])

    ctx = _make_ctx()
    client = SafirClient(base_url=BASE)
    result = await run_build_brief_review_responder(
        ctx=ctx, client=client, _llm_override=fake_llm
    )
    await client.aclose()

    assert result.status == "completed"
    assert result.reply_message_id == "msg-1"
    assert result.conflicts == []
