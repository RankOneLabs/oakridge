"""Render a structured planner-2 result as the markdown safir's parser accepts."""
from __future__ import annotations

from typing import Any


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


def render_from_atom_map(atom_map: dict[str, str], canonical: dict[str, Any]) -> str:
    """Build handoff markdown from a live atom_map + canonical handoff_docs row.

    The atom_map overrides individual field values; the canonical row provides
    structural information (list lengths) so we can reconstruct list fields even
    when atom_map entries are partial. Empty-string atoms are treated as
    tombstones (the item was deleted) and omitted from the output.
    """
    def av(anchor: str, fallback: str = "") -> str:
        return atom_map.get(anchor, fallback)

    goal = av("goal", canonical.get("goal") or "")
    next_action = av("next_action", canonical.get("next_action") or "")

    raw_subgoals = canonical.get("active_subgoals")
    canon_subgoals: list[str] = (raw_subgoals if isinstance(raw_subgoals, list) else []) or []
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

    raw_decisions = canonical.get("decisions_made")
    canon_decisions: list[dict[str, str]] = (
        raw_decisions if isinstance(raw_decisions, list) else []
    ) or []
    atom_dec_indices = _safe_indices(atom_map, "decisions_made")
    n_decisions = max(
        len(canon_decisions),
        (max(atom_dec_indices) + 1) if atom_dec_indices else 0,
    )
    decisions_made: list[dict[str, str]] = []
    for i in range(n_decisions):
        canon_d: dict[str, Any] = {}
        if i < len(canon_decisions) and isinstance(canon_decisions[i], dict):
            canon_d = canon_decisions[i]
        decision = av(f"decisions_made[{i}].decision", canon_d.get("decision", ""))
        if not decision:  # tombstoned
            continue
        rationale = av(f"decisions_made[{i}].rationale", canon_d.get("rationale", ""))
        decisions_made.append({"decision": decision, "rationale": rationale})

    raw_rejected = canonical.get("approaches_rejected")
    canon_rejected: list[dict[str, str]] = (
        raw_rejected if isinstance(raw_rejected, list) else []
    ) or []
    atom_rej_indices = _safe_indices(atom_map, "approaches_rejected")
    n_rejected = max(
        len(canon_rejected),
        (max(atom_rej_indices) + 1) if atom_rej_indices else 0,
    )
    approaches_rejected: list[dict[str, str]] = []
    for i in range(n_rejected):
        canon_r: dict[str, Any] = {}
        if i < len(canon_rejected) and isinstance(canon_rejected[i], dict):
            canon_r = canon_rejected[i]
        approach = av(f"approaches_rejected[{i}].approach", canon_r.get("approach", ""))
        if not approach:  # tombstoned
            continue
        reason = av(f"approaches_rejected[{i}].reason", canon_r.get("reason", ""))
        approaches_rejected.append({"approach": approach, "reason": reason})

    raw_files = canonical.get("files_in_scope")
    canon_files: list[str] = (raw_files if isinstance(raw_files, list) else []) or []
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

    raw_oq = canonical.get("open_questions")
    canon_oq: list[str] = (raw_oq if isinstance(raw_oq, list) else []) or []
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


def render_handoff_markdown(parsed: dict[str, Any]) -> str:
    """Convert a planner-2 JSON-shaped output into safir-handoff markdown.

    Field naming must match safir's parseHandoffMarkdown regex anchors
    (`## Goal`, `## Active subgoals`, etc.) so the regex parser produces
    equivalent output to the explicit `parsed:` field. Both ride on the
    submit_phase_handoff body together.
    """
    lines: list[str] = []
    lines.append(f"# {parsed.get('title', 'Handoff')}")
    lines.append("")
    lines.append("## Goal")
    lines.append("")
    lines.append(parsed.get("goal") or "")
    lines.append("")
    lines.append("## Active subgoals")
    lines.append("")
    for sg in parsed.get("active_subgoals", []) or []:
        lines.append(f"- {sg}")
    lines.append("")
    lines.append("## Decisions made")
    lines.append("")
    lines.append("| Decision | Rationale |")
    lines.append("|---|---|")
    for d in parsed.get("decisions_made", []) or []:
        decision = (d.get("decision") or "").replace("|", "\\|")
        rationale = (d.get("rationale") or "").replace("|", "\\|")
        lines.append(f"| {decision} | {rationale} |")
    lines.append("")
    lines.append("## Approaches rejected")
    lines.append("")
    for r in parsed.get("approaches_rejected", []) or []:
        approach = r.get("approach") or ""
        reason = r.get("reason") or ""
        lines.append(f"- **{approach}** — {reason}")
    lines.append("")
    lines.append("## Files in scope")
    lines.append("")
    for f in parsed.get("files_in_scope", []) or []:
        lines.append(f"- `{f}`")
    lines.append("")
    lines.append("## Open questions")
    lines.append("")
    open_q = parsed.get("open_questions") or []
    if not open_q:
        lines.append("(none)")
    else:
        for q in open_q:
            lines.append(f"- {q}")
    lines.append("")
    lines.append("## Next action")
    lines.append("")
    lines.append(parsed.get("next_action") or "")
    lines.append("")
    return "\n".join(lines)
