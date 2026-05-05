"""Data model entities for the workspace layer.

The boundary entities the project layer mediates over: agents (persistent
across projects), projects (bounded contexts), artifacts (the binding
object), briefs (read-only target spec), enrollments (agent ↔ project
binding).

Per the design memo, two persistence scopes:

- Agents accumulate cross-project skill (memory persists with the agent).
- Projects accumulate project-specific context (history travels with the
  artifact).

Neither scope leaks into the other.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator

from legit_biz_club.core.lifecycle import ProjectState


def _new_id() -> str:
    return str(uuid4())


def _utc_now() -> datetime:
    """UTC-aware ``datetime.now``. Naive timestamps would compare wrong
    across machines in different timezones and trip serialization.
    """
    return datetime.now(UTC)


class ArtifactType(StrEnum):
    """The two artifact types v1 supports.

    ``CODE`` artifacts are directories under version control; "next state"
    semantics for these is "next commit." ``PROSE`` artifacts are
    markdown files; "next state" is the full document at the proposed
    revision. Multi-artifact projects are deferred to v2+.
    """

    CODE = "code"
    PROSE = "prose"


class Artifact(BaseModel):
    """The shared artifact agents collaborate on.

    Files on disk are authoritative. Content is not stored in this model
    — ``path`` points at the location and the project layer consults the
    filesystem.
    """

    id: str = Field(default_factory=_new_id)
    type: ArtifactType
    path: Path

    @field_validator("path")
    @classmethod
    def _absolute(cls, v: Path) -> Path:
        return v.expanduser().resolve()


class Brief(BaseModel):
    """The target spec, success criteria, and constraints.

    Read-only to agents during the project. Read-only because the brief
    is the stable target for evals; if it shifts mid-project, eval
    comparability breaks down. Brief revision as a first-class
    agent-initiated flow is deferred to v2+.
    """

    target_spec: str
    success_criteria: list[str]
    constraints: list[str] = Field(default_factory=list)


class Agent(BaseModel):
    """A long-lived, persistent entity with its own identity, configuration,
    and accumulating memory.

    Agents persist across projects. Memory lives at ``memory_db_path``
    and is consumed via jig's ``SqliteStore``. Per-agent isolation comes
    from one db file per agent — no shared SQLite state across agents in
    the same process.
    """

    id: str = Field(default_factory=_new_id)
    name: str
    model: str
    """jig ``from_model`` identifier (e.g., 'claude-sonnet-4-5', 'gpt-5-mini')."""
    system_prompt: str
    frame: str | None = None
    """Optional intellectual stance: precision / skepticism / synthesis / etc.
    Honor system in v1 — no automatic similarity check on free-text frames."""
    memory_db_path: Path

    @field_validator("memory_db_path")
    @classmethod
    def _absolute(cls, v: Path) -> Path:
        return v.expanduser().resolve()


class Enrollment(BaseModel):
    """Binds an agent to a project.

    The optional ``binding`` is the design's diversity-via-binding
    primitive: each enrolled agent can be bound to a unique secondary
    entity within the ensemble (eval criterion, tool subset, artifact
    section, etc.). Uniqueness is enforced at enrollment time when the
    project's composition policy enables binding heterogeneity.
    """

    agent_id: str
    project_id: str
    enrolled_at: datetime = Field(default_factory=_utc_now)
    binding: dict[str, Any] | None = None

    @field_validator("binding")
    @classmethod
    def _binding_is_json_serializable(
        cls, v: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        """Reject bindings that can't survive ``json.dumps``.

        The heterogeneity check serializes the binding to a stable
        string key for uniqueness comparison; if serialization fails
        there it surfaces as a runtime error far from the construction
        site. Validating at the model boundary keeps the failure
        attached to the bad input.
        """
        if v is None:
            return v
        try:
            json.dumps(v, sort_keys=True)
        except (TypeError, ValueError) as e:
            raise ValueError(
                f"binding must be JSON-serializable: {e}"
            ) from e
        return v


class CoordinationProtocol(StrEnum):
    """How the project's coordinator orchestrates incremental + consensus phases.

    Selected per-project at construction time. The :class:`ProjectCoordinator`
    reads this field and dispatches to the matching combination of
    :class:`IncrementalCoordinator` and :class:`ConsensusMechanism`. v1
    supports three protocols; eval-driven dynamic protocols are v2+.
    """

    INCREMENTAL_ONLY = "incremental_only"
    """Only incremental commits; no convergence phase. Terminates via
    the configured :class:`TerminationPolicy` (default K commits per agent)."""

    INCREMENTAL_THEN_CONVERGE = "incremental_then_converge"
    """Run incremental commits to termination, then run a final
    consensus phase to resolve any remaining disagreement before ship."""

    MULTI_ROUND_FROM_START = "multi_round_from_start"
    """Skip incremental; go straight to multi-round consensus. Useful
    when the artifact starts from a clean slate and the goal is the
    ensemble's collective best output rather than a sequence of edits."""


class Project(BaseModel):
    """A bounded context that owns a shared artifact, a brief, and a set of
    enrolled agents.

    Lifecycle: spawn → enroll → iterate → ship/archive. State transitions
    go through :func:`legit_biz_club.core.lifecycle.transition_to`, not
    by direct mutation of ``state`` here.
    """

    id: str = Field(default_factory=_new_id)
    artifact: Artifact
    brief: Brief
    enrollments: list[Enrollment] = Field(default_factory=list)
    state: ProjectState = ProjectState.INITIALIZED
    coordination_protocol: CoordinationProtocol = CoordinationProtocol.INCREMENTAL_ONLY
    """Selects how :class:`ProjectCoordinator` runs the project. Default
    matches the v1 incremental-only behavior; opt into convergence
    phases per-project."""
    created_at: datetime = Field(default_factory=_utc_now)
    shipped_at: datetime | None = None
    archived_at: datetime | None = None
