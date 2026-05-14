"""Render a structured planner-2 result as the markdown safir's parser accepts."""
from __future__ import annotations

from typing import Any


def render_from_atom_map(atom_map: dict[str, str], canonical: dict[str, Any]) -> str:
    """Build handoff markdown from a live atom_map + canonical handoff_docs row.

    The atom_map overrides individual field values; the canonical row provides
    structural information (list lengths) so we can reconstruct list fields even
    when atom_map entries are partial.
    """
    def av(anchor: str, fallback: str = "") -> str:
        return atom_map.get(anchor, fallback)

    goal = av("goal", canonical.get("goal") or "")
    next_action = av("next_action", canonical.get("next_action") or "")

    canon_subgoals: list[str] = canonical.get("active_subgoals") or []
    n_subgoals = max(len(canon_subgoals), max(
        (int(k[len("active_subgoals["):-1]) + 1)
        for k in atom_map if k.startswith("active_subgoals[") and k.endswith("]")
    ) if any(k.startswith("active_subgoals[") for k in atom_map) else 0)
    active_subgoals = [
        av(f"active_subgoals[{i}]", canon_subgoals[i] if i < len(canon_subgoals) else "")
        for i in range(n_subgoals)
    ]

    canon_decisions: list[dict[str, str]] = canonical.get("decisions_made") or []
    n_decisions = max(len(canon_decisions), max(
        (int(k.split("[")[1].split("]")[0]) + 1)
        for k in atom_map if k.startswith("decisions_made[")
    ) if any(k.startswith("decisions_made[") for k in atom_map) else 0)
    decisions_made = [
        {
            "decision": av(
                f"decisions_made[{i}].decision",
                canon_decisions[i]["decision"] if i < len(canon_decisions) else "",
            ),
            "rationale": av(
                f"decisions_made[{i}].rationale",
                canon_decisions[i]["rationale"] if i < len(canon_decisions) else "",
            ),
        }
        for i in range(n_decisions)
    ]

    canon_rejected: list[dict[str, str]] = canonical.get("approaches_rejected") or []
    n_rejected = max(len(canon_rejected), max(
        (int(k.split("[")[1].split("]")[0]) + 1)
        for k in atom_map if k.startswith("approaches_rejected[")
    ) if any(k.startswith("approaches_rejected[") for k in atom_map) else 0)
    approaches_rejected = [
        {
            "approach": av(
                f"approaches_rejected[{i}].approach",
                canon_rejected[i]["approach"] if i < len(canon_rejected) else "",
            ),
            "reason": av(
                f"approaches_rejected[{i}].reason",
                canon_rejected[i]["reason"] if i < len(canon_rejected) else "",
            ),
        }
        for i in range(n_rejected)
    ]

    canon_files: list[str] = canonical.get("files_in_scope") or []
    n_files = max(len(canon_files), max(
        (int(k[len("files_in_scope["):-1]) + 1)
        for k in atom_map if k.startswith("files_in_scope[") and k.endswith("]")
    ) if any(k.startswith("files_in_scope[") for k in atom_map) else 0)
    files_in_scope = [
        av(f"files_in_scope[{i}]", canon_files[i] if i < len(canon_files) else "")
        for i in range(n_files)
    ]

    canon_oq: list[str] = canonical.get("open_questions") or []
    n_oq = max(len(canon_oq), max(
        (int(k[len("open_questions["):-1]) + 1)
        for k in atom_map if k.startswith("open_questions[") and k.endswith("]")
    ) if any(k.startswith("open_questions[") for k in atom_map) else 0)
    open_questions = [
        av(f"open_questions[{i}]", canon_oq[i] if i < len(canon_oq) else "")
        for i in range(n_oq)
    ]

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
