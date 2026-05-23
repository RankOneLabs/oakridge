"""Tests for builder.lib.handoff_validation."""
from __future__ import annotations

from builder.errors import HandoffShapeError
from builder.lib.handoff_validation import extract_json, validate_handoff
from builder.result import Err, Ok


def _valid_parsed() -> dict[str, object]:
    return {
        "title": "Do the thing",
        "goal": "deliver feature X",
        "active_subgoals": ["step 1", "step 2"],
        "decisions_made": [{"decision": "use A", "rationale": "because"}],
        "approaches_rejected": [{"approach": "use B", "reason": "slower"}],
        "files_in_scope": ["foo.py"],
        "open_questions": [],
        "next_action": "edit foo.py",
    }


# --- extract_json --------------------------------------------------------


def test_extract_json_plain_object() -> None:
    result = extract_json('{"a": 1, "b": "x"}')
    assert isinstance(result, Ok)
    assert result.value == {"a": 1, "b": "x"}


def test_extract_json_strips_code_fences() -> None:
    result = extract_json('```json\n{"a": 1}\n```')
    assert isinstance(result, Ok)
    assert result.value == {"a": 1}


def test_extract_json_skips_prose_preamble() -> None:
    result = extract_json('Here is the plan:\n{"a": 1}\nThanks!')
    assert isinstance(result, Ok)
    assert result.value == {"a": 1}


def test_extract_json_returns_err_when_absent() -> None:
    result = extract_json("no JSON here, just prose")
    assert isinstance(result, Err)
    assert isinstance(result.error, HandoffShapeError)
    assert result.error.op == "extract_json"


def test_extract_json_finds_first_object_inside_outer_array() -> None:
    # The scanner walks to the first '{', which sits inside the array.
    # Documented behavior: first parseable object wins.
    result = extract_json('[{"a": 1}]')
    assert isinstance(result, Ok)
    assert result.value == {"a": 1}


# --- validate_handoff ----------------------------------------------------


def test_validate_handoff_accepts_minimal_valid() -> None:
    parsed = _valid_parsed()
    result = validate_handoff(parsed)
    assert isinstance(result, Ok)
    assert result.value is parsed


def test_validate_handoff_rejects_missing_title() -> None:
    parsed = _valid_parsed()
    del parsed["title"]
    result = validate_handoff(parsed)
    assert isinstance(result, Err)
    assert "'title'" in result.error.detail


def test_validate_handoff_rejects_empty_decisions() -> None:
    parsed = _valid_parsed()
    parsed["decisions_made"] = []
    result = validate_handoff(parsed)
    assert isinstance(result, Err)
    assert "decisions_made" in result.error.detail


def test_validate_handoff_rejects_empty_files_in_scope() -> None:
    parsed = _valid_parsed()
    parsed["files_in_scope"] = []
    result = validate_handoff(parsed)
    assert isinstance(result, Err)
    assert "files_in_scope" in result.error.detail


def test_validate_handoff_accepts_open_question_with_all_punt_labels() -> None:
    parsed = _valid_parsed()
    parsed["open_questions"] = [
        "decision: which lib | would-pick: A | deferring-because: need ADR first"
    ]
    result = validate_handoff(parsed)
    assert isinstance(result, Ok)


def test_validate_handoff_rejects_open_question_missing_punt_labels() -> None:
    parsed = _valid_parsed()
    parsed["open_questions"] = ["should we punt or not?"]
    result = validate_handoff(parsed)
    assert isinstance(result, Err)
    assert "punt label" in result.error.detail


def test_validate_handoff_rejects_non_string_active_subgoal() -> None:
    parsed = _valid_parsed()
    parsed["active_subgoals"] = ["step 1", 42]
    result = validate_handoff(parsed)
    assert isinstance(result, Err)
    assert "active_subgoals[1]" in result.error.detail
