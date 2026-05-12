"""Planner-2: brief + dep handoffs + parent spec -> phase_output handoff."""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from jig.core.types import Message, Role
from jig.llm.factory import complete as llm_complete
from safir_py import SafirClient

from .handoff_render import render_handoff_markdown

PLANNER2_SYSTEM_PROMPT = """\
You are planner 2: you take a brief and the current state of the
working tree (via completed dep handoffs) and produce a build-ready
handoff. The handoff is the contract a lower-tier build agent will
execute mechanically.

Make all decisions. No optional choices. If any decision is not decided
it must be explicitly punted to later work; silent omission is the
failure mode you are guarding against.

"Punted" means: the unresolved decision is listed in open_questions as
a single string that includes all three labels (case-insensitive):

  decision: <what the decision is>
  would-pick: <the option you'd pick if forced now>
  deferring-because: <why you're deferring>

Punting is a deliberate, recorded act; not deciding without recording
is forbidden.

Output a single JSON object with these keys (no surrounding markdown,
no prose preamble, no trailing commentary). Output ONLY the JSON object:

{
  "title": "<one-line title>",
  "goal": "<one paragraph, what this brief delivers>",
  "active_subgoals": ["<step 1>", "<step 2>", ...],
  "decisions_made": [
    {"decision": "<X>", "rationale": "<why>"},
    ...
  ],
  "approaches_rejected": [
    {"approach": "<Y>", "reason": "<why>"},
    ...
  ],
  "files_in_scope": ["<path1>", "<path2>", ...],
  "open_questions": [
    "decision: <X> | would-pick: <Y> | deferring-because: <Z>",
    ...
  ],
  "next_action": "<the literal first step>"
}

Rules:
- decisions_made: minimum length 1. If a decision could have gone two
  ways, the rejected option goes in approaches_rejected. No "we could
  do A or B" phrasing in decisions_made.
- files_in_scope: minimum length 1. Every file the build agent should
  expect to touch, including new files to create (with their paths).
- open_questions: empty is the target. Non-empty is acceptable only
  when every entry includes all three labels in the (a)/(b)/(c) shape
  above. Free-form entries that don't include all three substrings
  ("decision:", "would-pick:", "deferring-because:") fail validation.

You are not allowed to write code in the handoff body beyond
illustrative snippets. The handoff is instructions, not implementation.

Before you emit the JSON: re-read your draft and ask "is there
anywhere a build agent reading this would have to make a choice?" If
yes, that choice is either a decision you should make and record in
decisions_made, or a punt you should record explicitly in
open_questions. Eliminate every implicit choice.
"""


class Planner2ValidationError(ValueError):
    """Raised when planner-2's output fails the shape validator."""


@dataclass
class Planner2Result:
    parsed: dict[str, Any]
    raw_markdown: str
    handoff_id: str


_PUNT_LABELS = ("decision:", "would-pick:", "deferring-because:")


def validate_handoff(parsed: dict[str, Any]) -> None:
    if not isinstance(parsed, dict):
        raise Planner2ValidationError(f"output is not a JSON object: {type(parsed)}")
    decisions = parsed.get("decisions_made")
    if not isinstance(decisions, list) or len(decisions) < 1:
        raise Planner2ValidationError("decisions_made must be a non-empty array")
    for i, item in enumerate(decisions):
        if not isinstance(item, dict):
            raise Planner2ValidationError(f"decisions_made[{i}] must be an object")
        for key in ("decision", "rationale"):
            val = item.get(key)
            if not isinstance(val, str) or not val.strip():
                raise Planner2ValidationError(
                    f"decisions_made[{i}].{key!r} must be a non-empty string"
                )
    files = parsed.get("files_in_scope")
    if not isinstance(files, list) or len(files) < 1:
        raise Planner2ValidationError("files_in_scope must be a non-empty array")
    for i, fpath in enumerate(files):
        if not isinstance(fpath, str) or not fpath.strip():
            raise Planner2ValidationError(f"files_in_scope[{i}] must be a non-empty string")
    open_q = parsed.get("open_questions", [])
    if open_q is None:
        open_q = []
    if not isinstance(open_q, list):
        raise Planner2ValidationError("open_questions must be an array")
    for i, q in enumerate(open_q):
        if not isinstance(q, str):
            raise Planner2ValidationError(f"open_questions[{i}] must be a string")
        low = q.lower()
        missing = [lbl for lbl in _PUNT_LABELS if lbl not in low]
        if missing:
            raise Planner2ValidationError(
                f"open_questions[{i}] is missing punt label(s) {missing}; "
                f"either decide the question or restate as an explicit "
                f"(a)/(b)/(c) punt with all three labels."
            )
    for k in ("goal", "next_action"):
        value = parsed.get(k)
        if not isinstance(value, str) or not value.strip():
            raise Planner2ValidationError(f"{k!r} must be a non-empty string")


def _build_context(
    *,
    brief_markdown: str,
    parent_spec: str,
    dep_handoffs_markdown: list[str],
) -> str:
    deps_section = "\n\n---\n\n".join(dep_handoffs_markdown) or "(no completed deps)"
    return (
        f"<parent-spec>\n{parent_spec}\n</parent-spec>\n\n"
        f"<dep-handoffs>\n{deps_section}\n</dep-handoffs>\n\n"
        f"<brief>\n{brief_markdown}\n</brief>"
    )


def _extract_json(content: str) -> dict[str, Any]:
    """Pull the first top-level JSON object out of the model's response.

    Models occasionally wrap JSON in ```json fences. Strip those then
    json.loads. Anything else is a hard parse failure surfacing to the
    retry loop.
    """
    s = content.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s[3:]
        if s.endswith("```"):
            s = s[: -len("```")].rstrip()
        elif "```" in s:
            s = s.rsplit("```", 1)[0].rstrip()
    return json.loads(s)  # type: ignore[no-any-return]


async def run_planner2(
    *,
    brief_markdown: str,
    parent_spec: str,
    dep_handoffs_markdown: list[str],
    phase_id: str,
    model: str,
    safir_client: SafirClient,
) -> Planner2Result:
    """Run planner-2 against the brief; submit the handoff to safir."""
    user_content = _build_context(
        brief_markdown=brief_markdown,
        parent_spec=parent_spec,
        dep_handoffs_markdown=dep_handoffs_markdown,
    )
    messages: list[Message] = [Message(role=Role.USER, content=user_content)]

    parsed: dict[str, Any]
    last_error: str | None = None
    for attempt in range(2):  # try once, retry once
        sys_prompt = PLANNER2_SYSTEM_PROMPT
        if attempt == 1 and last_error is not None:
            sys_prompt = (
                PLANNER2_SYSTEM_PROMPT
                + f"\n\nPrior attempt failed validation: {last_error}\n"
                + "Fix the issue and re-emit a complete JSON object."
            )
        resp = await llm_complete(model=model, messages=messages, system=sys_prompt)
        try:
            parsed = _extract_json(resp.content)
        except json.JSONDecodeError as e:
            last_error = f"JSON parse failed: {e}"
            continue
        try:
            validate_handoff(parsed)
        except Planner2ValidationError as e:
            last_error = str(e)
            continue
        break
    else:
        raise Planner2ValidationError(
            f"planner-2 failed validation twice; last error: {last_error}"
        )

    raw_markdown = render_handoff_markdown(parsed)
    submitted = await safir_client.submit_phase_handoff(
        phase_id=phase_id,
        raw_markdown=raw_markdown,
        parsed={
            "goal": parsed.get("goal", ""),
            "active_subgoals": parsed.get("active_subgoals", []) or [],
            "decisions_made": parsed.get("decisions_made", []) or [],
            "approaches_rejected": parsed.get("approaches_rejected", []) or [],
            "files_in_scope": parsed.get("files_in_scope", []) or [],
            "open_questions": parsed.get("open_questions", []) or [],
            "next_action": parsed.get("next_action", ""),
        },
    )
    return Planner2Result(
        parsed=parsed,
        raw_markdown=raw_markdown,
        handoff_id=submitted["id"],
    )
