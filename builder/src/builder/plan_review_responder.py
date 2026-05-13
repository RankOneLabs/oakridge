"""Plan review responder agent: responds to operator pings on plan threads."""
from __future__ import annotations

import json
import re
from typing import Any, cast

from jig.core.runner import AgentConfig, run_agent
from jig.core.types import Tool, ToolDefinition
from jig.llm.factory import from_model
from jig.tools.registry import ToolRegistry
from jig.tracing.stdout import StdoutTracer
from pydantic import BaseModel, Field

from safir_py import SafirClient

from .feedback import NoOpFeedback
from .review_responder_base import (
    ReviewResponderContext,
    ResponderResult,
    _call_safir_or_record_conflict,
)

PLAN_REVIEW_RESPONDER_SYSTEM_PROMPT = """\
You are the plan review responder. You are invoked when an operator pings
a thread on a plan artifact. Your job is to read the operator's comment,
inspect the plan (cohorts + dependency edges), make the requested edits,
and post a reply explaining what you did.

## Snapshot vs live state

You receive a frozen snapshot of the plan's atom map at dispatch time.
You use these snapshot values as `prev_value` in every atom edit you post
(this is how the CAS system detects concurrent drift). If you hit a
conflict (the server returns 409 stale_prev_value), record it — do NOT
auto-retry. Conflicts surface in your reply under "Conflicts I hit".

## Atom map format

The atom map is a flat dict mapping anchors to string values:
  - Cohort fields:    cohorts[N].title, cohorts[N].notes, cohorts[N].priority
  - Dependency edges: deps[from,to]  (value "1" = edge exists)

## Cross-anchor callout

If you edit cohorts or edges beyond the thread's anchor cohort, you MUST
name them explicitly in your reply. Invisible touches would surprise the
operator.

## Mandatory reply

You MUST call ReplyToThreadTool exactly once at the end of your turn. Your
reply should:
  1. Summarise what you did (edits made, validation passed/failed).
  2. List any conflicts under a "Conflicts I hit:" subsection (omit if none).
  3. List any cross-anchor touches.

If you finish editing without calling ReplyToThreadTool, the runner will
post a synthetic failure reply on your behalf.

## Cycle and missing-target validation

Before calling AddEdgeTool or SplitCohortTool / MergeCohortsTool (which
add edges), check that:
  - Both cohort indices exist in the atom map.
  - The new edge does not create a cycle in the current DAG.
If validation fails, report the error in your reply without posting the
edit; use the returned tool error to re-plan.

## Available tools

- EditCohortTool      — edit one or more fields on an existing cohort
- AddCohortTool       — add a new cohort (auto-allocates index)
- DeleteCohortTool    — delete a cohort and all its incident edges
- SplitCohortTool     — split a cohort into ≥2 new cohorts
- MergeCohortsTool    — merge ≥2 cohorts into one
- AddEdgeTool         — add a dependency edge between two cohorts
- DeleteEdgeTool      — remove a dependency edge
- ReplyToThreadTool   — post your reply (call exactly once at end)
"""

_MODEL = "claude-opus-4-7"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _cohort_indices(atom_map: dict[str, str]) -> set[int]:
    pattern = re.compile(r"^cohorts\[(\d+)\]")
    return {int(m.group(1)) for k in atom_map if (m := pattern.match(k))}


def _next_cohort_index(atom_map: dict[str, str]) -> int:
    existing = _cohort_indices(atom_map)
    return (max(existing) + 1) if existing else 0


def _parse_edge_keys(atom_map: dict[str, str]) -> set[tuple[int, int]]:
    pattern = re.compile(r"^deps\[(\d+),(\d+)\]$")
    edges: set[tuple[int, int]] = set()
    for k in atom_map:
        if m := pattern.match(k):
            edges.add((int(m.group(1)), int(m.group(2))))
    return edges


def _would_create_cycle(
    existing_edges: set[tuple[int, int]], new_from: int, new_to: int
) -> bool:
    if new_from == new_to:
        return True
    adj: dict[int, list[int]] = {}
    for f, t in existing_edges:
        adj.setdefault(f, []).append(t)
    # BFS from new_to; cycle if it can reach new_from
    visited: set[int] = set()
    stack = [new_to]
    while stack:
        node = stack.pop()
        if node == new_from:
            return True
        if node in visited:
            continue
        visited.add(node)
        stack.extend(adj.get(node, []))
    return False


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


class EditCohortTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="EditCohortTool",
            description="Edit one or more fields (title, notes, priority) on an existing cohort.",
            parameters={
                "type": "object",
                "required": ["cohort_index", "updates", "prev_values"],
                "properties": {
                    "cohort_index": {"type": "integer"},
                    "updates": {
                        "type": "object",
                        "description": "Field name → new string value (e.g. {\"title\": \"New Title\"}).",
                        "additionalProperties": {"type": "string"},
                    },
                    "prev_values": {
                        "type": "object",
                        "description": "Field name → prev string value from snapshot.",
                        "additionalProperties": {"type": "string"},
                    },
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        cohort_index = int(args["cohort_index"])
        updates: dict[str, str] = args.get("updates") or {}
        prev_values: dict[str, str] = args.get("prev_values") or {}
        ctx = self._ctx

        if cohort_index not in _cohort_indices(ctx.atom_map):
            return json.dumps({"error": f"cohort {cohort_index} not found in atom map"})

        results = []
        for field, new_value in updates.items():
            anchor = f"cohorts[{cohort_index}].{field}"
            body = {
                "anchor": anchor,
                "new_value": new_value,
                "prev_value": prev_values.get(field),
                "thread_id": ctx.thread_id,
            }
            edit = await _call_safir_or_record_conflict(self._client, ctx, body)
            if edit is not None:
                results.append({"anchor": anchor, "edit_id": edit.get("id")})
            else:
                results.append({"anchor": anchor, "conflict": True})

        return json.dumps({"edits": results})


class AddCohortTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="AddCohortTool",
            description="Add a new cohort; index is auto-allocated from the live atom map.",
            parameters={
                "type": "object",
                "required": ["title", "notes", "priority"],
                "properties": {
                    "title": {"type": "string"},
                    "notes": {"type": "string"},
                    "priority": {"type": "integer"},
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        ctx = self._ctx
        new_index = _next_cohort_index(ctx.atom_map)
        fields = {
            "title": str(args["title"]),
            "notes": str(args["notes"]),
            "priority": str(args["priority"]),
        }
        results = []
        for field, value in fields.items():
            anchor = f"cohorts[{new_index}].{field}"
            body = {
                "anchor": anchor,
                "new_value": value,
                "prev_value": None,
                "thread_id": ctx.thread_id,
            }
            edit = await _call_safir_or_record_conflict(self._client, ctx, body)
            if edit is not None:
                # Update snapshot so subsequent AddCohortTool calls don't collide.
                ctx.atom_map[anchor] = value
                results.append({"anchor": anchor, "edit_id": edit.get("id")})
            else:
                results.append({"anchor": anchor, "conflict": True})

        return json.dumps({"new_cohort_index": new_index, "edits": results})


class DeleteCohortTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="DeleteCohortTool",
            description="Delete a cohort and all its incident dependency edges.",
            parameters={
                "type": "object",
                "required": ["cohort_index"],
                "properties": {"cohort_index": {"type": "integer"}},
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        cohort_index = int(args["cohort_index"])
        ctx = self._ctx

        if cohort_index not in _cohort_indices(ctx.atom_map):
            return json.dumps({"error": f"cohort {cohort_index} not found"})

        results = []

        # Delete all incident edges first.
        edges = _parse_edge_keys(ctx.atom_map)
        for f, t in list(edges):
            if f == cohort_index or t == cohort_index:
                anchor = f"deps[{f},{t}]"
                body = {
                    "anchor": anchor,
                    "new_value": "",
                    "prev_value": ctx.atom_map.get(anchor, "1"),
                    "thread_id": ctx.thread_id,
                }
                edit = await _call_safir_or_record_conflict(self._client, ctx, body)
                results.append({"anchor": anchor, "conflict": edit is None})

        # Delete cohort attribute atoms.
        for key in list(ctx.atom_map):
            prefix = f"cohorts[{cohort_index}]."
            if key.startswith(prefix):
                body = {
                    "anchor": key,
                    "new_value": "",
                    "prev_value": ctx.atom_map[key],
                    "thread_id": ctx.thread_id,
                }
                edit = await _call_safir_or_record_conflict(self._client, ctx, body)
                results.append({"anchor": key, "conflict": edit is None})

        return json.dumps({"deleted_cohort_index": cohort_index, "edits": results})


class DepMigrationItem(BaseModel):
    from_edge: list[int] = Field(..., min_length=2, max_length=2)
    to_edges: list[list[int]]


class SplitCohortTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="SplitCohortTool",
            description=(
                "Split a cohort into ≥2 new cohorts with explicit dependency migration. "
                "dep_migration: list of {from_edge: [from,to], to_edges: [[f',t'], ...]}. "
                "splits: list of {new_index, title, notes, priority}."
            ),
            parameters={
                "type": "object",
                "required": ["cohort_index", "splits", "dep_migration"],
                "properties": {
                    "cohort_index": {"type": "integer"},
                    "splits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["new_index", "title", "notes", "priority"],
                            "properties": {
                                "new_index": {"type": "integer"},
                                "title": {"type": "string"},
                                "notes": {"type": "string"},
                                "priority": {"type": "integer"},
                            },
                        },
                    },
                    "dep_migration": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["from_edge", "to_edges"],
                            "properties": {
                                "from_edge": {"type": "array", "items": {"type": "integer"}},
                                "to_edges": {
                                    "type": "array",
                                    "items": {"type": "array", "items": {"type": "integer"}},
                                },
                            },
                        },
                    },
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        cohort_index = int(args["cohort_index"])
        splits: list[dict[str, Any]] = args["splits"]
        dep_migration: list[dict[str, Any]] = args.get("dep_migration") or []
        ctx = self._ctx

        if cohort_index not in _cohort_indices(ctx.atom_map):
            return json.dumps({"error": f"cohort {cohort_index} not found"})

        if len(splits) < 2:
            return json.dumps({"error": "split requires at least 2 new cohorts"})

        # Validate new indices don't already exist.
        existing = _cohort_indices(ctx.atom_map)
        for s in splits:
            ni = int(s["new_index"])
            if ni in existing:
                return json.dumps({"error": f"new_index {ni} already exists in atom map"})

        results: list[dict[str, Any]] = []

        # 1. Migrate edges per dep_migration: delete from_edge, add to_edges.
        current_edges = _parse_edge_keys(ctx.atom_map)
        for migration in dep_migration:
            fe = migration["from_edge"]
            from_anchor = f"deps[{fe[0]},{fe[1]}]"
            body = {
                "anchor": from_anchor,
                "new_value": "",
                "prev_value": ctx.atom_map.get(from_anchor, "1"),
                "thread_id": ctx.thread_id,
            }
            edit = await _call_safir_or_record_conflict(self._client, ctx, body)
            results.append({"anchor": from_anchor, "op": "delete_edge", "conflict": edit is None})

            for te in migration["to_edges"]:
                new_anchor = f"deps[{te[0]},{te[1]}]"
                # Cycle check against current set (excluding deleted from_edge)
                check_set = current_edges - {(fe[0], fe[1])}
                if _would_create_cycle(check_set, te[0], te[1]):
                    return json.dumps({"error": f"adding edge {te} would create a cycle"})
                body2 = {
                    "anchor": new_anchor,
                    "new_value": "1",
                    "prev_value": None,
                    "thread_id": ctx.thread_id,
                }
                edit2 = await _call_safir_or_record_conflict(self._client, ctx, body2)
                results.append({
                    "anchor": new_anchor,
                    "op": "add_edge",
                    "conflict": edit2 is None,
                })

        # 2. Delete original cohort attributes.
        for key in list(ctx.atom_map):
            if key.startswith(f"cohorts[{cohort_index}]."):
                body = {
                    "anchor": key,
                    "new_value": "",
                    "prev_value": ctx.atom_map[key],
                    "thread_id": ctx.thread_id,
                }
                edit = await _call_safir_or_record_conflict(self._client, ctx, body)
                results.append({"anchor": key, "op": "delete_orig", "conflict": edit is None})

        # 3. Add new split cohorts.
        for s in splits:
            ni = int(s["new_index"])
            for field, value in [
                ("title", str(s["title"])),
                ("notes", str(s["notes"])),
                ("priority", str(s["priority"])),
            ]:
                anchor = f"cohorts[{ni}].{field}"
                body = {
                    "anchor": anchor,
                    "new_value": value,
                    "prev_value": None,
                    "thread_id": ctx.thread_id,
                }
                edit = await _call_safir_or_record_conflict(self._client, ctx, body)
                if edit is not None:
                    ctx.atom_map[anchor] = value
                results.append({"anchor": anchor, "op": "add_split", "conflict": edit is None})

        return json.dumps({
            "original": cohort_index,
            "splits": [s["new_index"] for s in splits],
            "edits": results,
        })


class MergeCohortsTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="MergeCohortsTool",
            description=(
                "Merge ≥2 cohorts into one with explicit dependency migration. "
                "dep_migration: list of {from_edge: [from,to], to_edges: [[f',t'], ...]}. "
                "merged: {new_index, title, notes, priority}."
            ),
            parameters={
                "type": "object",
                "required": ["cohort_indices", "merged", "dep_migration"],
                "properties": {
                    "cohort_indices": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "minItems": 2,
                    },
                    "merged": {
                        "type": "object",
                        "required": ["new_index", "title", "notes", "priority"],
                        "properties": {
                            "new_index": {"type": "integer"},
                            "title": {"type": "string"},
                            "notes": {"type": "string"},
                            "priority": {"type": "integer"},
                        },
                    },
                    "dep_migration": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["from_edge", "to_edges"],
                            "properties": {
                                "from_edge": {"type": "array", "items": {"type": "integer"}},
                                "to_edges": {
                                    "type": "array",
                                    "items": {"type": "array", "items": {"type": "integer"}},
                                },
                            },
                        },
                    },
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        cohort_indices: list[int] = [int(i) for i in args["cohort_indices"]]
        merged: dict[str, Any] = args["merged"]
        dep_migration: list[dict[str, Any]] = args.get("dep_migration") or []
        ctx = self._ctx

        existing = _cohort_indices(ctx.atom_map)
        for ci in cohort_indices:
            if ci not in existing:
                return json.dumps({"error": f"cohort {ci} not found"})

        new_index = int(merged["new_index"])
        if new_index in existing:
            return json.dumps({"error": f"merged new_index {new_index} already exists"})

        results: list[dict[str, Any]] = []
        current_edges = _parse_edge_keys(ctx.atom_map)

        # 1. Migrate edges.
        for migration in dep_migration:
            fe = migration["from_edge"]
            from_anchor = f"deps[{fe[0]},{fe[1]}]"
            body = {
                "anchor": from_anchor,
                "new_value": "",
                "prev_value": ctx.atom_map.get(from_anchor, "1"),
                "thread_id": ctx.thread_id,
            }
            edit = await _call_safir_or_record_conflict(self._client, ctx, body)
            results.append({"anchor": from_anchor, "op": "delete_edge", "conflict": edit is None})

            for te in migration["to_edges"]:
                new_anchor = f"deps[{te[0]},{te[1]}]"
                check_set = current_edges - {(fe[0], fe[1])}
                if _would_create_cycle(check_set, te[0], te[1]):
                    return json.dumps({"error": f"adding edge {te} would create a cycle"})
                body2 = {
                    "anchor": new_anchor,
                    "new_value": "1",
                    "prev_value": None,
                    "thread_id": ctx.thread_id,
                }
                edit2 = await _call_safir_or_record_conflict(self._client, ctx, body2)
                results.append({
                    "anchor": new_anchor,
                    "op": "add_edge",
                    "conflict": edit2 is None,
                })

        # 2. Delete source cohorts.
        for ci in cohort_indices:
            for key in list(ctx.atom_map):
                if key.startswith(f"cohorts[{ci}]."):
                    body = {
                        "anchor": key,
                        "new_value": "",
                        "prev_value": ctx.atom_map[key],
                        "thread_id": ctx.thread_id,
                    }
                    edit = await _call_safir_or_record_conflict(self._client, ctx, body)
                    results.append({"anchor": key, "op": "delete_src", "conflict": edit is None})

        # 3. Add merged cohort.
        for field, value in [
            ("title", str(merged["title"])),
            ("notes", str(merged["notes"])),
            ("priority", str(merged["priority"])),
        ]:
            anchor = f"cohorts[{new_index}].{field}"
            body = {
                "anchor": anchor,
                "new_value": value,
                "prev_value": None,
                "thread_id": ctx.thread_id,
            }
            edit = await _call_safir_or_record_conflict(self._client, ctx, body)
            if edit is not None:
                ctx.atom_map[anchor] = value
            results.append({"anchor": anchor, "op": "add_merged", "conflict": edit is None})

        return json.dumps({
            "merged_indices": cohort_indices,
            "new_index": new_index,
            "edits": results,
        })


class AddEdgeTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="AddEdgeTool",
            description="Add a dependency edge between two existing cohorts. Validates cycle-free.",
            parameters={
                "type": "object",
                "required": ["from_index", "to_index"],
                "properties": {
                    "from_index": {"type": "integer"},
                    "to_index": {"type": "integer"},
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        from_index = int(args["from_index"])
        to_index = int(args["to_index"])
        ctx = self._ctx

        indices = _cohort_indices(ctx.atom_map)
        if from_index not in indices:
            return json.dumps({"error": f"from cohort {from_index} not found"})
        if to_index not in indices:
            return json.dumps({"error": f"to cohort {to_index} not found"})

        existing_edges = _parse_edge_keys(ctx.atom_map)
        if _would_create_cycle(existing_edges, from_index, to_index):
            return json.dumps({"error": f"adding edge [{from_index},{to_index}] would create a cycle"})

        anchor = f"deps[{from_index},{to_index}]"
        if anchor in ctx.atom_map:
            return json.dumps({"error": f"edge [{from_index},{to_index}] already exists"})

        body = {
            "anchor": anchor,
            "new_value": "1",
            "prev_value": None,
            "thread_id": ctx.thread_id,
        }
        edit = await _call_safir_or_record_conflict(self._client, ctx, body)
        if edit is None:
            return json.dumps({"anchor": anchor, "conflict": True})
        ctx.atom_map[anchor] = "1"
        return json.dumps({"anchor": anchor, "edit_id": edit.get("id")})


class DeleteEdgeTool(Tool):  # type: ignore[misc]
    def __init__(self, ctx: ReviewResponderContext, client: SafirClient) -> None:
        self._ctx = ctx
        self._client = client

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="DeleteEdgeTool",
            description="Remove a dependency edge between two cohorts.",
            parameters={
                "type": "object",
                "required": ["from_index", "to_index"],
                "properties": {
                    "from_index": {"type": "integer"},
                    "to_index": {"type": "integer"},
                },
            },
        )

    async def execute(self, args: dict[str, Any]) -> str:
        from_index = int(args["from_index"])
        to_index = int(args["to_index"])
        ctx = self._ctx

        anchor = f"deps[{from_index},{to_index}]"
        if anchor not in ctx.atom_map:
            return json.dumps({"error": f"edge [{from_index},{to_index}] not found"})

        body = {
            "anchor": anchor,
            "new_value": "",
            "prev_value": ctx.atom_map[anchor],
            "thread_id": ctx.thread_id,
        }
        edit = await _call_safir_or_record_conflict(self._client, ctx, body)
        if edit is None:
            return json.dumps({"anchor": anchor, "conflict": True})
        return json.dumps({"anchor": anchor, "edit_id": edit.get("id")})


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
                "Include a 'Conflicts I hit:' subsection if any conflicts occurred."
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
        "Respond to the operator's thread ping.",
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
        "## Other open threads on this artifact",
        json.dumps(
            [t.model_dump() for t in ctx.other_open_threads], indent=2
        ),
        "",
        "## Parent task notes",
        ctx.parent_task_notes,
    ]
    if ctx.dependency_briefs_notes:
        parts += ["", "## Dependency build brief notes"]
        parts += ctx.dependency_briefs_notes
    return "\n".join(parts)


async def run_plan_review_responder(
    *,
    ctx: ReviewResponderContext,
    client: SafirClient,
    _llm_override: Any = None,
) -> ResponderResult:
    tools = ToolRegistry(
        [
            EditCohortTool(ctx, client),
            AddCohortTool(ctx, client),
            DeleteCohortTool(ctx, client),
            SplitCohortTool(ctx, client),
            MergeCohortsTool(ctx, client),
            AddEdgeTool(ctx, client),
            DeleteEdgeTool(ctx, client),
            ReplyToThreadTool(ctx, client),
        ]
    )
    llm = _llm_override if _llm_override is not None else from_model(_MODEL)
    config: AgentConfig[None] = AgentConfig(
        name="plan_review_responder",
        description="Responds to operator pings on plan review threads.",
        system_prompt=PLAN_REVIEW_RESPONDER_SYSTEM_PROMPT,
        llm=llm,
        feedback=NoOpFeedback(),
        tracer=StdoutTracer(color=False),
        tools=tools,
        max_tool_calls=80,
        max_llm_calls=100,
    )
    await run_agent(config, _build_input(ctx))

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
