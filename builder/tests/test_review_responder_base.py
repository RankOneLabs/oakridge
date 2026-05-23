"""Tests for review_responder_base: models and _call_safir_or_record_conflict."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from safir_py import SafirAtomEditConflict

from builder.review_responder_base import (
    ConflictRecord,
    ReviewResponderContext,
    ThreadMessage,
    ThreadSnapshot,
    _call_safir_or_record_conflict,
    record_conflict,
)

BASE_THREAD = ThreadSnapshot(
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
            body="Please split cohort 0.",
            created_at="2026-01-01T00:00:00Z",
        )
    ],
)


def _make_ctx(**overrides: Any) -> ReviewResponderContext:
    defaults: dict[str, Any] = {
        "target_type": "plan",
        "target_id": "plan-1",
        "thread_id": "thread-1",
        "thread": BASE_THREAD,
        "atom_map": {"cohorts[0].title": "Cohort Zero"},
        "other_open_threads": [],
        "parent_task_notes": "Build the thing.",
    }
    defaults.update(overrides)
    return ReviewResponderContext(**defaults)


# ---------------------------------------------------------------------------
# record_conflict
# ---------------------------------------------------------------------------


def test_record_conflict_appends() -> None:
    ctx = _make_ctx()
    assert ctx.conflicts == []
    conflict = ConflictRecord(
        anchor="cohorts[0].title",
        attempted_value="New Title",
        current_value="Concurrent Title",
        latest_edit_id="edit-99",
    )
    record_conflict(ctx, conflict)
    assert len(ctx.conflicts) == 1
    assert ctx.conflicts[0].anchor == "cohorts[0].title"


def test_record_conflict_multiple() -> None:
    ctx = _make_ctx()
    for i in range(3):
        record_conflict(
            ctx,
            ConflictRecord(
                anchor=f"cohorts[{i}].title",
                attempted_value=f"v{i}",
                current_value=None,
                latest_edit_id=f"e{i}",
            ),
        )
    assert len(ctx.conflicts) == 3


# ---------------------------------------------------------------------------
# _call_safir_or_record_conflict — success path
# ---------------------------------------------------------------------------


class _SuccessStub:
    async def post_atom_edit(
        self, target_type: str, target_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        return {"id": "edit-1", "anchor": body["anchor"]}


@pytest.mark.asyncio
async def test_call_safir_success_returns_edit() -> None:
    ctx = _make_ctx()
    body = {"anchor": "cohorts[0].title", "new_value": "Updated", "prev_value": "Cohort Zero"}
    result = await _call_safir_or_record_conflict(_SuccessStub(), ctx, body)
    assert result is not None
    assert result["id"] == "edit-1"
    assert ctx.conflicts == []


# ---------------------------------------------------------------------------
# _call_safir_or_record_conflict — 409 conflict path
# ---------------------------------------------------------------------------


class _ConflictStub:
    def __init__(self, *, current_value: str | None, latest_edit_id: str) -> None:
        self._current_value = current_value
        self._latest_edit_id = latest_edit_id

    async def post_atom_edit(
        self, target_type: str, target_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        raise SafirAtomEditConflict(
            current_value=self._current_value,
            latest_edit_id=self._latest_edit_id,
            edited_by="someone",
            created_at="2026-01-01T00:01:00Z",
        )


@pytest.mark.asyncio
async def test_call_safir_409_records_conflict_and_returns_none() -> None:
    ctx = _make_ctx()
    body = {"anchor": "cohorts[0].title", "new_value": "Updated", "prev_value": "Cohort Zero"}
    result = await _call_safir_or_record_conflict(
        _ConflictStub(current_value="Concurrent Title", latest_edit_id="edit-77"),
        ctx,
        body,
    )
    assert result is None
    assert len(ctx.conflicts) == 1
    c = ctx.conflicts[0]
    assert c.anchor == "cohorts[0].title"
    assert c.attempted_value == "Updated"
    assert c.current_value == "Concurrent Title"
    assert c.latest_edit_id == "edit-77"


@pytest.mark.asyncio
async def test_call_safir_409_null_current_value() -> None:
    ctx = _make_ctx()
    body = {"anchor": "cohorts[0].title", "new_value": "X", "prev_value": "old"}
    result = await _call_safir_or_record_conflict(
        _ConflictStub(current_value=None, latest_edit_id="edit-0"),
        ctx,
        body,
    )
    assert result is None
    assert ctx.conflicts[0].current_value is None


# ---------------------------------------------------------------------------
# _call_safir_or_record_conflict — transport errors become synthetic conflicts
# ---------------------------------------------------------------------------


class _RequestErrorStub:
    async def post_atom_edit(
        self, target_type: str, target_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        raise httpx.RequestError("network error")


@pytest.mark.asyncio
async def test_call_safir_request_error_records_conflict_and_returns_none() -> None:
    ctx = _make_ctx()
    body = {"anchor": "cohorts[0].title", "new_value": "X", "prev_value": "old"}
    result = await _call_safir_or_record_conflict(_RequestErrorStub(), ctx, body)
    assert result is None
    assert len(ctx.conflicts) == 1
    assert ctx.conflicts[0].anchor == "cohorts[0].title"


# ---------------------------------------------------------------------------
# Multiple conflicts accumulate
# ---------------------------------------------------------------------------


class _AlwaysConflictStub:
    async def post_atom_edit(
        self, target_type: str, target_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        raise SafirAtomEditConflict(
            current_value="concurrent",
            latest_edit_id="e99",
            edited_by="someone",
            created_at="2026-01-01T00:01:00Z",
        )


@pytest.mark.asyncio
async def test_multiple_conflicts_accumulate() -> None:
    ctx = _make_ctx()
    for anchor in ["cohorts[0].title", "cohorts[0].notes", "cohorts[1].title"]:
        await _call_safir_or_record_conflict(
            _AlwaysConflictStub(),
            ctx,
            {"anchor": anchor, "new_value": "v", "prev_value": "old"},
        )
    assert len(ctx.conflicts) == 3
    assert [c.anchor for c in ctx.conflicts] == [
        "cohorts[0].title",
        "cohorts[0].notes",
        "cohorts[1].title",
    ]
