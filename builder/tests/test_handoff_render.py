"""Tests for render_handoff_markdown."""
from __future__ import annotations

from builder.handoff_render import render_handoff_markdown


def _minimal() -> dict:
    return {
        "title": "My Handoff",
        "goal": "Do a thing.",
        "active_subgoals": ["Step 1", "Step 2"],
        "decisions_made": [{"decision": "Use Python", "rationale": "It's fast"}],
        "approaches_rejected": [],
        "files_in_scope": ["src/foo.py"],
        "open_questions": [],
        "next_action": "Start with Step 1.",
    }


def test_round_trip_contains_all_headers() -> None:
    md = render_handoff_markdown(_minimal())
    for header in [
        "## Goal",
        "## Active subgoals",
        "## Decisions made",
        "## Approaches rejected",
        "## Files in scope",
        "## Open questions",
        "## Next action",
    ]:
        assert header in md, f"missing {header!r}"


def test_open_questions_empty_renders_none() -> None:
    md = render_handoff_markdown(_minimal())
    assert "(none)" in md


def test_open_questions_non_empty_renders_list_item() -> None:
    parsed = _minimal()
    parsed["open_questions"] = ["decision: X | would-pick: Y | deferring-because: Z"]
    md = render_handoff_markdown(parsed)
    assert "- decision: X | would-pick: Y | deferring-because: Z" in md
    assert "(none)" not in md


def test_pipe_in_decision_is_escaped() -> None:
    parsed = _minimal()
    parsed["decisions_made"] = [{"decision": "A|B", "rationale": "C|D"}]
    md = render_handoff_markdown(parsed)
    assert "A\\|B" in md
    assert "C\\|D" in md


def test_empty_arrays_produce_empty_sections() -> None:
    parsed = _minimal()
    parsed["active_subgoals"] = []
    parsed["approaches_rejected"] = []
    md = render_handoff_markdown(parsed)
    # No bullet rows for empty active_subgoals
    lines = md.splitlines()
    subgoals_idx = next(i for i, l in enumerate(lines) if l == "## Active subgoals")
    # Line after blank should not be a bullet
    after = lines[subgoals_idx + 2] if subgoals_idx + 2 < len(lines) else ""
    assert not after.startswith("-")
