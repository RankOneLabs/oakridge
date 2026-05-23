"""Render a structured planner-2 result as handoff markdown."""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TypedDict


class HandoffDecision(TypedDict):
    decision: str
    rationale: str


class HandoffRejectedApproach(TypedDict):
    approach: str
    reason: str


class HandoffMarkdown(TypedDict):
    title: str
    goal: str
    next_action: str
    active_subgoals: list[str]
    decisions_made: list[HandoffDecision]
    approaches_rejected: list[HandoffRejectedApproach]
    files_in_scope: list[str]
    open_questions: list[str]


HandoffMarkdownInput = Mapping[str, object]


def _safe_indices(atom_map: dict[str, str], prefix: str) -> list[int]:
    """Return the distinct integer indices found in atom_map keys starting with prefix[."""
    out: list[int] = []
    bracket = f"{prefix}["
    for k in atom_map:
        if k.startswith(bracket):
            try:
                idx = int(k[len(bracket):].split("]")[0])
                if idx >= 0:
                    out.append(idx)
            except (ValueError, IndexError):
                pass
    return out


def _string_value(value: object) -> str:
    return value if isinstance(value, str) else ""


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _decisions(value: object) -> list[HandoffDecision]:
    if not isinstance(value, list):
        return []
    out: list[HandoffDecision] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        decision = _string_value(item.get("decision"))
        rationale = _string_value(item.get("rationale"))
        if decision or rationale:
            out.append({"decision": decision, "rationale": rationale})
    return out


def _rejected_approaches(value: object) -> list[HandoffRejectedApproach]:
    if not isinstance(value, list):
        return []
    out: list[HandoffRejectedApproach] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        approach = _string_value(item.get("approach"))
        reason = _string_value(item.get("reason"))
        if approach or reason:
            out.append({"approach": approach, "reason": reason})
    return out


def _decision_atom(value: str) -> HandoffDecision | None:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, Mapping):
        return None
    decision = _string_value(parsed.get("decision"))
    rationale = _string_value(parsed.get("rationale"))
    if not decision and not rationale:
        return None
    return {"decision": decision, "rationale": rationale}


def _rejected_approach_atom(value: str) -> HandoffRejectedApproach | None:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, Mapping):
        return None
    approach = _string_value(parsed.get("approach"))
    reason = _string_value(parsed.get("reason"))
    if not approach and not reason:
        return None
    return {"approach": approach, "reason": reason}


def _normalize_handoff(parsed: HandoffMarkdownInput) -> HandoffMarkdown:
    return {
        "title": _string_value(parsed.get("title")) or "Handoff",
        "goal": _string_value(parsed.get("goal")),
        "next_action": _string_value(parsed.get("next_action")),
        "active_subgoals": _string_list(parsed.get("active_subgoals")),
        "decisions_made": _decisions(parsed.get("decisions_made")),
        "approaches_rejected": _rejected_approaches(parsed.get("approaches_rejected")),
        "files_in_scope": _string_list(parsed.get("files_in_scope")),
        "open_questions": _string_list(parsed.get("open_questions")),
    }


def render_from_atom_map(atom_map: dict[str, str], canonical: HandoffMarkdownInput) -> str:
    """Build handoff markdown from a live atom_map + canonical handoff_docs row.

    The atom_map overrides individual field values; the canonical row provides
    structural information (list lengths) so we can reconstruct list fields even
    when atom_map entries are partial. Empty-string atoms are treated as
    tombstones (the item was deleted) and omitted from the output.
    """
    normalized = _normalize_handoff(canonical)

    def av(anchor: str, fallback: str = "") -> str:
        return atom_map.get(anchor, fallback)

    goal = av("goal", normalized["goal"])
    next_action = av("next_action", normalized["next_action"])

    canon_subgoals = normalized["active_subgoals"]
    atom_sg_indices = _safe_indices(atom_map, "active_subgoals")
    n_subgoals = max(
        len(canon_subgoals),
        (max(atom_sg_indices) + 1) if atom_sg_indices else 0,
    )
    active_subgoals: list[str] = []
    for i in range(n_subgoals):
        fallback = canon_subgoals[i] if i < len(canon_subgoals) else ""
        val = av(f"active_subgoals[{i}]", fallback)
        if val:
            active_subgoals.append(val)

    canon_decisions = normalized["decisions_made"]
    atom_dec_indices = _safe_indices(atom_map, "decisions_made")
    n_decisions = max(
        len(canon_decisions),
        (max(atom_dec_indices) + 1) if atom_dec_indices else 0,
    )
    decisions_made: list[HandoffDecision] = []
    for i in range(n_decisions):
        atom_decision = atom_map.get(f"decisions_made[{i}]")
        if atom_decision is not None:
            if not atom_decision:
                continue
            decision_from_atom = _decision_atom(atom_decision)
            if decision_from_atom is not None and decision_from_atom["decision"]:
                decisions_made.append(decision_from_atom)
                continue
        canon_d: HandoffDecision = {"decision": "", "rationale": ""}
        if i < len(canon_decisions):
            canon_d = canon_decisions[i]
        decision = av(f"decisions_made[{i}].decision", canon_d["decision"])
        if not decision:
            continue
        rationale = av(f"decisions_made[{i}].rationale", canon_d["rationale"])
        decisions_made.append({"decision": decision, "rationale": rationale})

    canon_rejected = normalized["approaches_rejected"]
    atom_rej_indices = _safe_indices(atom_map, "approaches_rejected")
    n_rejected = max(
        len(canon_rejected),
        (max(atom_rej_indices) + 1) if atom_rej_indices else 0,
    )
    approaches_rejected: list[HandoffRejectedApproach] = []
    for i in range(n_rejected):
        atom_rejected = atom_map.get(f"approaches_rejected[{i}]")
        if atom_rejected is not None:
            if not atom_rejected:
                continue
            rejected_from_atom = _rejected_approach_atom(atom_rejected)
            if rejected_from_atom is not None and rejected_from_atom["approach"]:
                approaches_rejected.append(rejected_from_atom)
                continue
        canon_r: HandoffRejectedApproach = {"approach": "", "reason": ""}
        if i < len(canon_rejected):
            canon_r = canon_rejected[i]
        approach = av(f"approaches_rejected[{i}].approach", canon_r["approach"])
        if not approach:
            continue
        reason = av(f"approaches_rejected[{i}].reason", canon_r["reason"])
        approaches_rejected.append({"approach": approach, "reason": reason})

    canon_files = normalized["files_in_scope"]
    atom_file_indices = _safe_indices(atom_map, "files_in_scope")
    n_files = max(
        len(canon_files),
        (max(atom_file_indices) + 1) if atom_file_indices else 0,
    )
    files_in_scope: list[str] = []
    for i in range(n_files):
        fallback = canon_files[i] if i < len(canon_files) else ""
        val = av(f"files_in_scope[{i}]", fallback)
        if val:
            files_in_scope.append(val)

    canon_oq = normalized["open_questions"]
    atom_oq_indices = _safe_indices(atom_map, "open_questions")
    n_oq = max(
        len(canon_oq),
        (max(atom_oq_indices) + 1) if atom_oq_indices else 0,
    )
    open_questions: list[str] = []
    for i in range(n_oq):
        fallback = canon_oq[i] if i < len(canon_oq) else ""
        val = av(f"open_questions[{i}]", fallback)
        if val:
            open_questions.append(val)

    return render_handoff_markdown({
        "title": "Build brief",
        "goal": goal,
        "next_action": next_action,
        "active_subgoals": active_subgoals,
        "decisions_made": decisions_made,
        "approaches_rejected": approaches_rejected,
        "files_in_scope": files_in_scope,
        "open_questions": open_questions,
    })


def render_handoff_markdown(parsed: HandoffMarkdownInput) -> str:
    """Convert a planner-2 JSON-shaped output into handoff markdown.

    Field naming must match the handoff parser's regex anchors
    (`## Goal`, `## Active subgoals`, etc.) so the regex parser produces
    equivalent output to the explicit `parsed:` field. Both ride on the
    submit_phase_handoff body together.
    """
    handoff = _normalize_handoff(parsed)
    lines: list[str] = []
    lines.append(f"# {handoff['title']}")
    lines.append("")
    lines.append("## Goal")
    lines.append("")
    lines.append(handoff["goal"])
    lines.append("")
    lines.append("## Active subgoals")
    lines.append("")
    for sg in handoff["active_subgoals"]:
        lines.append(f"- {sg}")
    lines.append("")
    lines.append("## Decisions made")
    lines.append("")
    lines.append("| Decision | Rationale |")
    lines.append("|---|---|")
    for d in handoff["decisions_made"]:
        decision = d["decision"].replace("|", "\\|")
        rationale = d["rationale"].replace("|", "\\|")
        lines.append(f"| {decision} | {rationale} |")
    lines.append("")
    lines.append("## Approaches rejected")
    lines.append("")
    for r in handoff["approaches_rejected"]:
        approach = r["approach"]
        reason = r["reason"]
        lines.append(f"- **{approach}** — {reason}")
    lines.append("")
    lines.append("## Files in scope")
    lines.append("")
    for f in handoff["files_in_scope"]:
        lines.append(f"- `{f}`")
    lines.append("")
    lines.append("## Open questions")
    lines.append("")
    open_q = handoff["open_questions"]
    if not open_q:
        lines.append("(none)")
    else:
        for q in open_q:
            lines.append(f"- {q}")
    lines.append("")
    lines.append("## Next action")
    lines.append("")
    lines.append(handoff["next_action"])
    lines.append("")
    return "\n".join(lines)
