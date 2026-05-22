"""Tests for builder.lib.atom_map."""
from __future__ import annotations

from builder.lib.atom_map import (
    LIST_FIELDS,
    cohort_indices,
    list_keys,
    next_cohort_index,
    next_list_index,
    parse_edge_keys,
    would_create_cycle,
)


# --- list_keys + next_list_index -----------------------------------------


def test_list_keys_returns_sorted() -> None:
    am = {
        "active_subgoals[2]": "c",
        "active_subgoals[0]": "a",
        "active_subgoals[1]": "b",
        "goal": "g",  # ignored
    }
    assert list_keys(am, "active_subgoals") == [
        "active_subgoals[0]",
        "active_subgoals[1]",
        "active_subgoals[2]",
    ]


def test_list_keys_empty_when_field_absent() -> None:
    assert list_keys({"goal": "g"}, "files_in_scope") == []


def test_next_list_index_empty_returns_zero() -> None:
    assert next_list_index({}, "open_questions") == 0


def test_next_list_index_after_existing() -> None:
    am = {"files_in_scope[0]": "a.py", "files_in_scope[1]": "b.py"}
    assert next_list_index(am, "files_in_scope") == 2


def test_list_fields_covers_expected_handoff_keys() -> None:
    assert {
        "active_subgoals",
        "decisions_made",
        "approaches_rejected",
        "files_in_scope",
        "open_questions",
    } == set(LIST_FIELDS)


# --- cohort_indices + next_cohort_index ----------------------------------


def test_cohort_indices_extracts_from_anchors() -> None:
    am = {
        "cohorts[0].title": "x",
        "cohorts[0].notes": "y",
        "cohorts[3].title": "z",
        "deps[0,3]": "1",  # ignored
    }
    assert cohort_indices(am) == {0, 3}


def test_next_cohort_index_empty_returns_zero() -> None:
    assert next_cohort_index({}) == 0


def test_next_cohort_index_after_existing() -> None:
    am = {"cohorts[0].title": "a", "cohorts[2].title": "b"}
    assert next_cohort_index(am) == 3


# --- parse_edge_keys + would_create_cycle --------------------------------


def test_parse_edge_keys_extracts_endpoints() -> None:
    am = {
        "deps[0,1]": "1",
        "deps[1,2]": "1",
        "cohorts[0].title": "x",  # ignored
    }
    assert parse_edge_keys(am) == {(0, 1), (1, 2)}


def test_would_create_cycle_self_edge() -> None:
    assert would_create_cycle(set(), 0, 0) is True


def test_would_create_cycle_no_cycle() -> None:
    assert would_create_cycle({(0, 1)}, 1, 2) is False


def test_would_create_cycle_simple_cycle() -> None:
    assert would_create_cycle({(0, 1)}, 1, 0) is True


def test_would_create_cycle_transitive_cycle() -> None:
    assert would_create_cycle({(0, 1), (1, 2)}, 2, 0) is True


def test_would_create_cycle_unrelated_components() -> None:
    assert would_create_cycle({(0, 1), (2, 3)}, 1, 2) is False
