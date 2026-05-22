"""Domain error variants for planner1.

Each variant is a frozen dataclass carrying `op_name`, `entity_id`, and
`detail` so a trace can reconstruct where and why a failure occurred
(see ``standards/backend.md``). The union is exposed as ``PlannerError``
and consumed via ``match`` on ``Err(...)`` from ``planner1.result``.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SafirIOError:
    op_name: str
    entity_id: str | int | None
    detail: str


@dataclass(frozen=True, slots=True)
class EmptyTaskNotesError:
    op_name: str
    entity_id: str | int | None
    detail: str


@dataclass(frozen=True, slots=True)
class EmptyPlanError:
    op_name: str
    entity_id: str | int | None
    detail: str


@dataclass(frozen=True, slots=True)
class PlannerRunFailedError:
    op_name: str
    entity_id: str | int | None
    detail: str


@dataclass(frozen=True, slots=True)
class StagingCycleError:
    op_name: str
    entity_id: str | int | None
    detail: str


@dataclass(frozen=True, slots=True)
class StagingIndexOutOfRangeError:
    op_name: str
    entity_id: str | int | None
    detail: str


@dataclass(frozen=True, slots=True)
class ToolArgsInvalidError:
    op_name: str
    entity_id: str | int | None
    detail: str


type PlannerError = (
    SafirIOError
    | EmptyTaskNotesError
    | EmptyPlanError
    | PlannerRunFailedError
    | StagingCycleError
    | StagingIndexOutOfRangeError
    | ToolArgsInvalidError
)
