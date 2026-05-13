"""Build brief review responder agent: responds to operator pings on brief threads."""
from __future__ import annotations

import json
import re
from typing import Any

from jig.core.runner import AgentConfig, run_agent
from jig.core.types import Tool, ToolDefinition
from jig.llm.factory import from_model
from jig.tools.registry import ToolRegistry
from jig.tracing.stdout import StdoutTracer

from safir_py import SafirClient

from .feedback import NoOpFeedback
from .review_responder_base import (
    ReviewResponderContext,
    ResponderResult,
    _call_safir_or_record_conflict,
)

BUILD_BRIEF_REVIEW_RESPONDER_SYSTEM_PROMPT = """\
You are the build brief review responder. You are invoked when an operator
pings a thread on a build brief artifact. Your job is to read the comment,
inspect the brief's atom map, make the requested edits, and post a reply.

## Snapshot vs live state

You receive a frozen snapshot of the atom map at dispatch time. Use snapshot
values as `prev_value` in every atom edit (CAS detects concurrent drift).
On 409 stale_prev_value: record the conflict, do NOT retry. Surface
conflicts in your reply under "Conflicts I hit:".

## Atom map format

The build brief atom map is a flat dict:
  - Scalar fields: "goal", "next_action"
  - List elements: "active_subgoals[N]" → string
  - Object list elements: "decisions_made[N]" → JSON string {"decision":…,"rationale":…}
                          "approaches_rejected[N]" → JSON string {"approach":…,"reason":…}
                          "files_in_scope[N]" → string
                          "open_questions[N]" → string

## Index shifting on delete

When you delete a list element at index K from an N-element list:
  1. Delete anchor[K] (new_value="", prev_value=snapshot[K])
  2. For each i in K+1..N-1: edit anchor[K+(i-K-1)] ← snapshot[i]
     meaning: anchor[i-1] gets new_value=snapshot[i], prev_value=snapshot[i-1] (post-prior-shift)
     BUT use snapshot prev_values: set prev_value=snapshot[i-1] for each shift
  3. Delete the last anchor[N-1] (new_value="", prev_value=snapshot[N-1])

Your reply MUST mention the shift explicitly (e.g. "Note: indices shifted down
after deletion.").

## Mandatory reply

Call ReplyToThreadTool exactly once at end of turn. Include:
  1. Summary of edits made.
  2. "Conflicts I hit:" subsection (omit if none).
  3. Note any index shifts.

## Available tools

- EditAtomTool    — set any single atom to a new value
- AppendAtomTool  — append an element to a list field (auto-allocates index)
- DeleteAtomTool  — delete a list element and issue the shift sequence
- ReplyToThreadTool — post your reply (call exactly once at end)
"""

_MODEL = "claude-opus-4-7"

_LIST_FIELDS = frozenset([
    "active_subgoals",
    "decisions_made",
    "approaches_rejected",
    "files_in_scope",
    "open_questions",
])


def _list_keys(atom_map: dict[str, str], field: str) -> list[str]:
    """Return sorted anchor keys for a list field, e.g. ['decisions_made[0]', ...]."""
    pattern = re.compile(rf"^{re.escape(field)}\[(\d+)\]$")
    keys = [(int(m.group(1)), k) for k in atom_map if (m := pattern.match(k))]
    return [k for _, k in sorted(keys)]


def _next_list_index(atom_map: dict[str, str], field: str) -> int:
    keys = _list_keys(atom_map, field)
    if not keys:
        return 0
    last = keys[-1]
    m = re.search(r"\[(\d+)\]$", last)
    return int(m.group(1)) + 1 if m else 0


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


class EditAtomTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="EditAtomTool",
            description="Set a single atom to a new value (CAS-safe via prev_value).",
            parameters={
                "type": "object",
                "required": ["anchor", "new_value", "prev_value"],
                "properties": {
                    "anchor": {"type": "string", "description": "Atom key, e.g. 'goal'."},
                    "new_value": {"type": "string"},
                    "prev_value": {
                        "type": "string",
                        "description": "Current value from snapshot (null for new atoms).",
                        "nullable": True,
                    },
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        anchor = str(args["anchor"])
        new_value = str(args["new_value"])
        prev_value = args.get("prev_value")
        body = {
            "anchor": anchor,
            "new_value": new_value,
            "prev_value": prev_value,
            "thread_id": self._ctx.thread_id,
        }
        edit = await _call_safir_or_record_conflict(self._client, self._ctx, body)
        if edit is None:
            return json.dumps({"anchor": anchor, "conflict": True})
        return json.dumps({"anchor": anchor, "edit_id": edit.get("id")})


class AppendAtomTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="AppendAtomTool",
            description=(
                "Append an element to a list field. "
                "For object-list fields (decisions_made, approaches_rejected) "
                "pass value as a JSON string. "
                "Index is auto-allocated; prev_value is always null."
            ),
            parameters={
                "type": "object",
                "required": ["field", "value"],
                "properties": {
                    "field": {
                        "type": "string",
                        "enum": list(_LIST_FIELDS),
                        "description": "The list field to append to.",
                    },
                    "value": {
                        "type": "string",
                        "description": "New element value (JSON string for object-list fields).",
                    },
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        field = str(args["field"])
        if field not in _LIST_FIELDS:
            return json.dumps({"error": f"unknown list field: {field}"})
        value = str(args["value"])
        ctx = self._ctx
        new_index = _next_list_index(ctx.atom_map, field)
        anchor = f"{field}[{new_index}]"
        body = {
            "anchor": anchor,
            "new_value": value,
            "prev_value": None,
            "thread_id": ctx.thread_id,
        }
        edit = await _call_safir_or_record_conflict(self._client, ctx, body)
        if edit is None:
            return json.dumps({"anchor": anchor, "conflict": True})
        ctx.atom_map[anchor] = value
        return json.dumps({"anchor": anchor, "new_index": new_index, "edit_id": edit.get("id")})


class DeleteAtomTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="DeleteAtomTool",
            description=(
                "Delete a list element by anchor and issue an index-shift sequence. "
                "Anchor must be a list element like 'decisions_made[1]'. "
                "The shift posts one edit per subsequent element and one delete "
                "on the last element. Mention the shift in your reply."
            ),
            parameters={
                "type": "object",
                "required": ["anchor"],
                "properties": {
                    "anchor": {
                        "type": "string",
                        "description": "Anchor of the element to delete, e.g. 'decisions_made[1]'.",
                    },
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        anchor = str(args["anchor"])
        ctx = self._ctx

        if anchor not in ctx.atom_map:
            return json.dumps({"error": f"anchor '{anchor}' not found in atom map"})

        # Parse field and index.
        m = re.match(r"^(\w+)\[(\d+)\]$", anchor)
        if not m:
            return json.dumps({"error": f"anchor '{anchor}' is not a list element"})
        field = m.group(1)
        if field not in _LIST_FIELDS:
            return json.dumps({"error": f"'{field}' is not a deletable list field"})
        del_index = int(m.group(2))

        all_keys = _list_keys(ctx.atom_map, field)
        indices = sorted(int(k[k.index("[") + 1:-1]) for k in all_keys)
        if indices != list(range(len(indices))):
            return json.dumps({"error": f"non-contiguous indices for '{field}': {indices}"})
        n = len(all_keys)
        results: list[dict[str, Any]] = []

        # Step 1: delete the target element.
        del_prev = ctx.atom_map[anchor]
        body = {
            "anchor": anchor,
            "new_value": "",
            "prev_value": del_prev,
            "thread_id": ctx.thread_id,
        }
        edit = await _call_safir_or_record_conflict(self._client, ctx, body)
        results.append({"anchor": anchor, "op": "delete", "conflict": edit is None})

        # Step 2: shift subsequent elements down by one.
        for i in range(del_index + 1, n):
            src_anchor = f"{field}[{i}]"
            dst_anchor = f"{field}[{i - 1}]"
            src_value = ctx.atom_map.get(src_anchor, "")
            # prev_value for dst: use snapshot value at dst (which is i-1 original or "" after prior delete/shift)
            # Per spec: "each with the correct prev_value from the snapshot."
            # For the shift of element i → i-1:
            #   - if i-1 == del_index: prev_value is "" (just deleted)
            #   - otherwise: prev_value is snapshot value of dst (i-1)
            if i - 1 == del_index:
                dst_prev = ""
            else:
                dst_prev = ctx.atom_map.get(dst_anchor, "")

            shift_body = {
                "anchor": dst_anchor,
                "new_value": src_value,
                "prev_value": dst_prev,
                "thread_id": ctx.thread_id,
            }
            shift_edit = await _call_safir_or_record_conflict(self._client, ctx, shift_body)
            results.append({
                "anchor": dst_anchor,
                "op": "shift",
                "from": src_anchor,
                "conflict": shift_edit is None,
            })

        # Step 3: delete the last element (now a duplicate after shifting).
        if n > 1:
            last_anchor = f"{field}[{n - 1}]"
            last_prev = ctx.atom_map.get(last_anchor, "")
            del_last_body = {
                "anchor": last_anchor,
                "new_value": "",
                "prev_value": last_prev,
                "thread_id": ctx.thread_id,
            }
            del_last_edit = await _call_safir_or_record_conflict(
                self._client, ctx, del_last_body
            )
            results.append({
                "anchor": last_anchor,
                "op": "delete_last",
                "conflict": del_last_edit is None,
            })

        # Reflect deletion + shift in the working atom_map so subsequent
        # _next_list_index calls compute correct indices.
        ctx.atom_map.pop(anchor, None)
        for i in range(del_index + 1, n):
            ctx.atom_map[f"{field}[{i - 1}]"] = ctx.atom_map.pop(f"{field}[{i}]", "")
        ctx.atom_map.pop(f"{field}[{n - 1}]", None)

        return json.dumps({
            "deleted": anchor,
            "shifted": n - 1 - del_index,
            "edits": results,
        })


class ReplyToThreadTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="ReplyToThreadTool",
            description=(
                "Post your reply to the thread. Call exactly once at end of turn. "
                "Include 'Conflicts I hit:' if any; note any index shifts."
            ),
            parameters={
                "type": "object",
                "required": ["body"],
                "properties": {
                    "body": {"type": "string", "description": "Reply text (markdown OK)."},
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        if self._ctx.reply_message_id is not None:
            return json.dumps({"error": "reply already posted"})
        body_text = str(args["body"])
        msg = await self._client.post_thread_message(
            self._ctx.thread_id, {"body": body_text}
        )
        self._ctx.reply_message_id = msg.get("id")
        return json.dumps({"reply_message_id": self._ctx.reply_message_id, "ok": True})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _build_input(ctx: ReviewResponderContext) -> str:
    parts = [
        "Respond to the operator's thread ping on this build brief.",
        "",
        f"Thread anchor: {ctx.thread.anchor}",
        f"Thread ID: {ctx.thread_id}",
        "",
        "## Operator messages",
    ]
    for msg in ctx.thread.messages:
        parts.append(f"[{msg.author}] {msg.body}")
    parts += [
        "",
        "## Current atom map (snapshot)",
        json.dumps(ctx.atom_map, indent=2),
        "",
        "## Other open threads on this brief",
        json.dumps([t.model_dump() for t in ctx.other_open_threads], indent=2),
        "",
        "## Parent task notes",
        ctx.parent_task_notes,
    ]
    if ctx.dependency_briefs_notes:
        parts += ["", "## Dependency build brief notes"]
        parts += ctx.dependency_briefs_notes
    return "\n".join(parts)


async def run_build_brief_review_responder(
    *,
    ctx: ReviewResponderContext,
    client: SafirClient,
    _llm_override: Any = None,
) -> ResponderResult:
    tools = ToolRegistry(
        [
            EditAtomTool(ctx, client),
            AppendAtomTool(ctx, client),
            DeleteAtomTool(ctx, client),
            ReplyToThreadTool(ctx, client),
        ]
    )
    llm = _llm_override if _llm_override is not None else from_model(_MODEL)
    config: AgentConfig[None] = AgentConfig(
        name="build_brief_review_responder",
        description="Responds to operator pings on build brief review threads.",
        system_prompt=BUILD_BRIEF_REVIEW_RESPONDER_SYSTEM_PROMPT,
        llm=llm,
        feedback=NoOpFeedback(),
        tracer=StdoutTracer(color=False),
        tools=tools,
        max_tool_calls=80,
        max_llm_calls=100,
    )
    try:
        await run_agent(config, _build_input(ctx))
    except Exception as exc:
        msg = await client.post_thread_message(
            ctx.thread_id,
            {"body": "agent failed before posting a reply; consult logs"},
        )
        return ResponderResult(
            status="failed",
            reply_message_id=msg.get("id"),
            conflicts=ctx.conflicts,
            error=str(exc),
        )

    if ctx.reply_message_id is None:
        msg = await client.post_thread_message(
            ctx.thread_id,
            {"body": "agent terminated without a reply; consult logs"},
        )
        return ResponderResult(
            status="failed",
            reply_message_id=msg.get("id"),
            conflicts=ctx.conflicts,
            error="agent terminated without calling ReplyToThreadTool",
        )

    return ResponderResult(
        status="completed",
        reply_message_id=ctx.reply_message_id,
        conflicts=ctx.conflicts,
    )
