"""Pure handoff JSON extraction + shape validation for planner-2.

Extracted from ``planner2.py`` so it can be unit-tested in isolation and
so the planner-2 retry loop only contains orchestration. Both functions
return ``Result[..., HandoffShapeError]`` instead of raising — the
planner-2 retry loop matches on the ``Err`` to decide whether to retry.
"""
from __future__ import annotations

import json
from typing import Any

from ..errors import HandoffShapeError
from ..result import Err, Ok, Result

_PUNT_LABELS = ("decision:", "would-pick:", "deferring-because:")


def extract_json(content: str) -> Result[dict[str, Any], HandoffShapeError]:
    """Pull the first top-level JSON object out of the model's response.

    Strips ``` fences and scans for the first ``{`` so prose preamble or
    trailing commentary does not produce a hard failure.
    """
    s = content.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s[3:]
        if s.endswith("```"):
            s = s[: -len("```")].rstrip()
        elif "```" in s:
            s = s.rsplit("```", 1)[0].rstrip()
    decoder = json.JSONDecoder()
    for i, ch in enumerate(s):
        if ch != "{":
            continue
        try:
            obj, _ = decoder.raw_decode(s[i:])
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return Ok(obj)
    return Err(
        HandoffShapeError(
            op="extract_json",
            entity_id=None,
            detail="no top-level JSON object found in response",
        )
    )


def validate_handoff(parsed: dict[str, Any]) -> Result[dict[str, Any], HandoffShapeError]:
    """Validate the planner-2 output shape.

    Returns the input ``parsed`` unchanged on success so the caller can
    chain ``match`` without re-binding the value.
    """
    if not isinstance(parsed, dict):
        return _shape_err(f"output is not a JSON object: {type(parsed)}")
    title = parsed.get("title")
    if not isinstance(title, str) or not title.strip():
        return _shape_err("'title' must be a non-empty string")
    active_subgoals = parsed.get("active_subgoals") or []
    if not isinstance(active_subgoals, list):
        return _shape_err("active_subgoals must be an array")
    for i, sg in enumerate(active_subgoals):
        if not isinstance(sg, str) or not sg.strip():
            return _shape_err(f"active_subgoals[{i}] must be a non-empty string")
    approaches_rejected = parsed.get("approaches_rejected") or []
    if not isinstance(approaches_rejected, list):
        return _shape_err("approaches_rejected must be an array")
    for i, item in enumerate(approaches_rejected):
        if not isinstance(item, dict):
            return _shape_err(f"approaches_rejected[{i}] must be an object")
        for key in ("approach", "reason"):
            val = item.get(key)
            if not isinstance(val, str) or not val.strip():
                return _shape_err(
                    f"approaches_rejected[{i}].{key!r} must be a non-empty string"
                )
    decisions = parsed.get("decisions_made")
    if not isinstance(decisions, list) or len(decisions) < 1:
        return _shape_err("decisions_made must be a non-empty array")
    for i, item in enumerate(decisions):
        if not isinstance(item, dict):
            return _shape_err(f"decisions_made[{i}] must be an object")
        for key in ("decision", "rationale"):
            val = item.get(key)
            if not isinstance(val, str) or not val.strip():
                return _shape_err(
                    f"decisions_made[{i}].{key!r} must be a non-empty string"
                )
    files = parsed.get("files_in_scope")
    if not isinstance(files, list) or len(files) < 1:
        return _shape_err("files_in_scope must be a non-empty array")
    for i, fpath in enumerate(files):
        if not isinstance(fpath, str) or not fpath.strip():
            return _shape_err(f"files_in_scope[{i}] must be a non-empty string")
    open_q = parsed.get("open_questions", [])
    if open_q is None:
        open_q = []
    if not isinstance(open_q, list):
        return _shape_err("open_questions must be an array")
    for i, q in enumerate(open_q):
        if not isinstance(q, str):
            return _shape_err(f"open_questions[{i}] must be a string")
        low = q.lower()
        missing = [lbl for lbl in _PUNT_LABELS if lbl not in low]
        if missing:
            return _shape_err(
                f"open_questions[{i}] is missing punt label(s) {missing}; "
                f"either decide the question or restate as an explicit "
                f"(a)/(b)/(c) punt with all three labels."
            )
    for k in ("goal", "next_action"):
        value = parsed.get(k)
        if not isinstance(value, str) or not value.strip():
            return _shape_err(f"{k!r} must be a non-empty string")
    return Ok(parsed)


def _shape_err(detail: str) -> Err[HandoffShapeError]:
    return Err(HandoffShapeError(op="validate_handoff", entity_id=None, detail=detail))
