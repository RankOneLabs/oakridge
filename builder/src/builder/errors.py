"""Builder domain error hierarchy.

Each variant carries `op` (the operation that failed), `entity_id` (the
safir id involved, when available), and `detail` (a human-readable
message) per ``.catagents/standards/backend.md``. The hierarchy is
flat — every variant inherits directly from ``BuilderError`` so the CLI
can exhaustively match on the concrete class to assign an exit code.

Errors are returned as the ``Err`` payload of ``Result[T, BuilderError]``;
they are not raised across layer boundaries.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class BuilderError:
    op: str
    entity_id: str | int | None
    detail: str


@dataclass(frozen=True, slots=True)
class BriefNotApprovedError(BuilderError):
    pass


@dataclass(frozen=True, slots=True)
class BuildAlreadyStartedError(BuilderError):
    pass


@dataclass(frozen=True, slots=True)
class PlanValidationError(BuilderError):
    pass


@dataclass(frozen=True, slots=True)
class HandoffShapeError(BuilderError):
    pass


@dataclass(frozen=True, slots=True)
class ModelsArgError(BuilderError):
    pass


@dataclass(frozen=True, slots=True)
class ConfigError(BuilderError):
    pass


@dataclass(frozen=True, slots=True)
class SafirIOError(BuilderError):
    pass
