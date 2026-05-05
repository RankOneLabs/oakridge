"""State-machine tests.

Cover the happy path (full spawn → ship arc), early archival, and the
invariant that terminal states are absorbing.
"""
from __future__ import annotations

import pytest

from legit_biz_club import (
    InvalidTransitionError,
    ProjectState,
    transition_to,
)


def test_happy_path_to_shipped() -> None:
    state = ProjectState.INITIALIZED
    state = transition_to(state, ProjectState.ENROLLING)
    state = transition_to(state, ProjectState.ACTIVE)
    state = transition_to(state, ProjectState.SHIPPED)
    assert state == ProjectState.SHIPPED


def test_archive_from_any_non_terminal() -> None:
    for start in (
        ProjectState.INITIALIZED,
        ProjectState.ENROLLING,
        ProjectState.ACTIVE,
    ):
        assert transition_to(start, ProjectState.ARCHIVED) == ProjectState.ARCHIVED


def test_terminal_states_absorb() -> None:
    for terminal in (ProjectState.SHIPPED, ProjectState.ARCHIVED):
        for target in ProjectState:
            with pytest.raises(InvalidTransitionError):
                transition_to(terminal, target)


def test_cannot_skip_enrolling() -> None:
    with pytest.raises(InvalidTransitionError):
        transition_to(ProjectState.INITIALIZED, ProjectState.ACTIVE)


def test_cannot_self_transition() -> None:
    with pytest.raises(InvalidTransitionError):
        transition_to(ProjectState.ACTIVE, ProjectState.ACTIVE)


def test_cannot_ship_before_active() -> None:
    with pytest.raises(InvalidTransitionError):
        transition_to(ProjectState.ENROLLING, ProjectState.SHIPPED)
