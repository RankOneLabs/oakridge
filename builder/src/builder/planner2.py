"""Planner-2: brief + dep handoffs + parent spec -> phase_output handoff."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from jig.core.types import Message, Role
from jig.llm.factory import complete as llm_complete
from safir_py import SafirClient

from .errors import BuilderError, HandoffShapeError
from .handoff_render import render_handoff_markdown
from .lib.handoff_validation import extract_json, validate_handoff
from .result import Err, Ok, Result

logger = logging.getLogger(__name__)

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


@dataclass(frozen=True, slots=True)
class Planner2Result:
    parsed: dict[str, Any]
    raw_markdown: str
    handoff_id: str


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


def _attempt(
    response_text: str,
) -> Result[dict[str, Any], HandoffShapeError]:
    """Parse + validate a single planner-2 response."""
    match extract_json(response_text):
        case Ok(value=parsed):
            return validate_handoff(parsed)
        case Err(error=err):
            return Err(err)


async def run_planner2(
    *,
    brief_markdown: str,
    parent_spec: str,
    dep_handoffs_markdown: list[str],
    phase_id: str,
    model: str,
    safir_client: SafirClient,
) -> Planner2Result:
    """Run planner-2 against the brief; submit the handoff to safir.

    Raises on terminal failure (validation failed twice). IO errors from
    safir propagate. Callers are expected to be inside the pipeline's
    outer phase-rollback try/except.
    """
    user_content = _build_context(
        brief_markdown=brief_markdown,
        parent_spec=parent_spec,
        dep_handoffs_markdown=dep_handoffs_markdown,
    )
    messages: list[Message] = [Message(role=Role.USER, content=user_content)]

    parsed: dict[str, Any] | None = None
    last_error: BuilderError | None = None
    for attempt in range(2):  # try once, retry once
        sys_prompt = PLANNER2_SYSTEM_PROMPT
        if attempt == 1 and last_error is not None:
            sys_prompt = (
                PLANNER2_SYSTEM_PROMPT
                + f"\n\nPrior attempt failed validation: {last_error.detail}\n"
                + "Fix the issue and re-emit a complete JSON object."
            )
        logger.info("planner2 attempt=%d model=%s phase_id=%s", attempt, model, phase_id)
        resp = await llm_complete(model=model, messages=messages, system=sys_prompt)
        match _attempt(resp.content):
            case Ok(value=ok_parsed):
                parsed = ok_parsed
                logger.info(
                    "planner2 attempt=%d validated phase_id=%s", attempt, phase_id
                )
                break
            case Err(error=err):
                last_error = err
                logger.warning(
                    "planner2 attempt=%d validation failed phase_id=%s detail=%s",
                    attempt,
                    phase_id,
                    err.detail,
                )

    if parsed is None:
        assert last_error is not None
        logger.error(
            "planner2 failed validation twice phase_id=%s detail=%s",
            phase_id,
            last_error.detail,
        )
        raise RuntimeError(
            f"planner-2 failed validation twice; last error: {last_error.detail}"
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
    logger.info(
        "handoff submitted handoff_id=%s phase_id=%s", submitted.id, phase_id
    )
    return Planner2Result(
        parsed=parsed,
        raw_markdown=raw_markdown,
        handoff_id=submitted.id,
    )
