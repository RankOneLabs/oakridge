"""Project lifecycle state machine.

States: INITIALIZED → ENROLLING → ACTIVE → (SHIPPED | ARCHIVED).

Direct mutation of ``Project.state`` is discouraged; coordination modes
and operator commands route through ``transition_to`` so invariants stay
enforceable. Terminal states (SHIPPED, ARCHIVED) reject all transitions.
"""
from __future__ import annotations

from enum import StrEnum


class ProjectState(StrEnum):
    INITIALIZED = "initialized"
    ENROLLING = "enrolling"
    ACTIVE = "active"
    SHIPPED = "shipped"
    ARCHIVED = "archived"


_ALLOWED_TRANSITIONS: dict[ProjectState, frozenset[ProjectState]] = {
    ProjectState.INITIALIZED: frozenset({ProjectState.ENROLLING, ProjectState.ARCHIVED}),
    ProjectState.ENROLLING: frozenset({ProjectState.ACTIVE, ProjectState.ARCHIVED}),
    ProjectState.ACTIVE: frozenset({ProjectState.SHIPPED, ProjectState.ARCHIVED}),
    ProjectState.SHIPPED: frozenset(),
    ProjectState.ARCHIVED: frozenset(),
}


class InvalidTransitionError(ValueError):
    """Raised when a transition is not in the allowed set for the current state."""


def transition_to(current: ProjectState, target: ProjectState) -> ProjectState:
    """Validate a state transition and return the target state.

    Raises :class:`InvalidTransitionError` if ``target`` is not reachable
    from ``current``. Self-transitions are rejected (the allowed set
    excludes the current state); callers that want a no-op should check
    equality first.
    """
    if target not in _ALLOWED_TRANSITIONS[current]:
        raise InvalidTransitionError(
            f"cannot transition from {current.value} to {target.value}"
        )
    return target
