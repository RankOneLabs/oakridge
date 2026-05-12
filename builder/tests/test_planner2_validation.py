"""Tests for validate_handoff and _extract_json (no LLM calls)."""
from __future__ import annotations

import json

import pytest

from builder.planner2 import Planner2ValidationError, _extract_json, validate_handoff


def _valid() -> dict:
    return {
        "title": "T",
        "goal": "Do it.",
        "active_subgoals": [],
        "decisions_made": [{"decision": "A", "rationale": "B"}],
        "approaches_rejected": [],
        "files_in_scope": ["src/foo.py"],
        "open_questions": [],
        "next_action": "Do first step.",
    }


def test_valid_minimal_passes() -> None:
    validate_handoff(_valid())  # no exception


def test_decisions_made_empty_raises() -> None:
    d = _valid()
    d["decisions_made"] = []
    with pytest.raises(Planner2ValidationError, match="decisions_made"):
        validate_handoff(d)


def test_files_in_scope_empty_raises() -> None:
    d = _valid()
    d["files_in_scope"] = []
    with pytest.raises(Planner2ValidationError, match="files_in_scope"):
        validate_handoff(d)


def test_open_questions_free_form_raises() -> None:
    d = _valid()
    d["open_questions"] = ["I'm not sure about X"]
    with pytest.raises(Planner2ValidationError, match="punt label"):
        validate_handoff(d)


def test_open_questions_case_insensitive_passes() -> None:
    d = _valid()
    d["open_questions"] = ["DECISION: x | Would-Pick: y | Deferring-Because: z"]
    validate_handoff(d)  # no exception


def test_open_questions_non_string_raises() -> None:
    d = _valid()
    d["open_questions"] = [123]
    with pytest.raises(Planner2ValidationError, match="must be a string"):
        validate_handoff(d)


def test_goal_empty_raises() -> None:
    d = _valid()
    d["goal"] = ""
    with pytest.raises(Planner2ValidationError, match="'goal'"):
        validate_handoff(d)


def test_next_action_empty_raises() -> None:
    d = _valid()
    d["next_action"] = ""
    with pytest.raises(Planner2ValidationError, match="'next_action'"):
        validate_handoff(d)


def test_extract_json_strips_fences() -> None:
    raw = '```json\n{"a": 1}\n```'
    result = _extract_json(raw)
    assert result == {"a": 1}


def test_extract_json_bare_object() -> None:
    raw = '{"x": "y"}'
    result = _extract_json(raw)
    assert result == {"x": "y"}


def test_extract_json_garbage_raises() -> None:
    with pytest.raises(json.JSONDecodeError):
        _extract_json("not json at all @@")
