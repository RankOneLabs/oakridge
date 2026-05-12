"""Render a structured planner-2 result as the markdown safir's parser accepts."""
from __future__ import annotations

from typing import Any


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
