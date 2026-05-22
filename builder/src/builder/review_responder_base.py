"""Shared models and helpers for plan and build-brief review responders."""
from __future__ import annotations

import logging
from typing import Any, Literal, Protocol

import httpx
from pydantic import BaseModel, Field
from safir_py import AtomEdit, SafirAtomEditConflict

logger = logging.getLogger(__name__)


class ThreadMessage(BaseModel):
    id: str
    thread_id: str
    author: str
    body: str
    related_edit_id: str | None = None
    created_at: str


class ThreadSnapshot(BaseModel):
    """Full thread record including all messages, frozen at dispatch time."""

    id: str
    target_type: Literal["plan", "build_brief"]
    target_id: str
    anchor: str | None = None
    status: Literal["open", "resolved"]
    agent_responding: int
    resolved_at: str | None = None
    created_at: str
    messages: list[ThreadMessage]


class ThreadMetadata(BaseModel):
    """Lightweight thread summary (no messages) for sibling-thread listing."""

    id: str
    target_type: Literal["plan", "build_brief"]
    target_id: str
    anchor: str | None = None
    status: Literal["open", "resolved"]
    created_at: str


class ConflictRecord(BaseModel):
    anchor: str
    attempted_value: str | None
    current_value: str | None
    latest_edit_id: str | None


class ReviewResponderContext(BaseModel):
    target_type: Literal["plan", "build_brief"]
    target_id: str
    thread_id: str
    thread: ThreadSnapshot
    atom_map: dict[str, str]
    other_open_threads: list[ThreadMetadata]
    parent_task_notes: str
    dependency_briefs_notes: list[str] | None = None
    # Mutable working state — tools append here via record_conflict().
    conflicts: list[ConflictRecord] = Field(default_factory=list)
    # Set by ReplyToThreadTool when it successfully posts.
    reply_message_id: str | None = None


class ResponderResult(BaseModel):
    status: Literal["completed", "failed"] = "completed"
    reply_message_id: str | None = None
    conflicts: list[ConflictRecord] = Field(default_factory=list)
    error: str | None = None


class AtomEditClient(Protocol):
    """Structural interface required by _call_safir_or_record_conflict."""

    async def post_atom_edit(
        self,
        target_type: str,
        target_id: str,
        body: dict[str, Any],
    ) -> AtomEdit: ...


def record_conflict(ctx: ReviewResponderContext, conflict: ConflictRecord) -> None:
    ctx.conflicts.append(conflict)
    logger.warning(
        "atom_edit CAS conflict thread_id=%s anchor=%s latest_edit_id=%s",
        ctx.thread_id,
        conflict.anchor,
        conflict.latest_edit_id,
    )


async def _call_safir_or_record_conflict(
    client: AtomEditClient,
    ctx: ReviewResponderContext,
    body: dict[str, Any],
) -> AtomEdit | None:
    """POST one atom edit to safir.

    IO edge (b): the only place in the responders where safir HTTP errors
    are converted to in-band conflict records. On 200 returns the typed
    edit record. On 409 stale_prev_value records the conflict and returns
    None. On any other httpx error, surfaces a synthetic conflict record
    so the agent can continue editing and report it rather than dying.
    """
    try:
        return await client.post_atom_edit(ctx.target_type, ctx.target_id, body)
    except SafirAtomEditConflict as e:
        record_conflict(
            ctx,
            ConflictRecord(
                anchor=body.get("anchor", ""),
                attempted_value=body.get("new_value"),
                current_value=e.current_value,
                latest_edit_id=e.latest_edit_id,
            ),
        )
        return None
    except httpx.HTTPStatusError as e:
        logger.error(
            "atom_edit IO error thread_id=%s anchor=%s status=%d",
            ctx.thread_id,
            body.get("anchor", ""),
            e.response.status_code,
        )
        record_conflict(
            ctx,
            ConflictRecord(
                anchor=body.get("anchor", ""),
                attempted_value=body.get("new_value"),
                current_value=None,
                latest_edit_id=None,
            ),
        )
        return None
