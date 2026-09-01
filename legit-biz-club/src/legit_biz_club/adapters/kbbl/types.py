"""Pydantic models mirroring kbbl's TS types.

Hand-written to match kbbl's exported shapes. A drift smoke test
(``tests/test_kbbl_contract.py``, added in PR #4 when adapter consumption
goes live) hits each kbbl endpoint with known input and validates response
shape against these models. OpenAPI generation is deferred to v2.

kbbl serializes JSON in camelCase; this module's pydantic config pairs
Python snake_case attribute names with camelCase JSON aliases via
``alias_generator``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _KbblModel(BaseModel):
    """Base for kbbl-shaped types — camelCase JSON, snake_case Python."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )


class CreateArtifactSessionRequest(BaseModel):
    """Wire body for ``POST /sessions`` when tagging a session to an artifact."""

    model_config = ConfigDict(extra="forbid")

    workdir: str
    artifact_id: str
    name: str | None = None


WorkspaceEventPayload = Mapping[str, object]


class WorkspaceEventRequest(_KbblModel):
    """Wire body for ``POST /inbox/workspace-events``."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )

    kind: str
    project_id: str
    payload: WorkspaceEventPayload | None = None


SessionStatus = Literal[
    "provisioning", "idle", "prompting", "ended", "fenced", "failed", "unknown"
]


class ResultUsage(BaseModel):
    """Token usage block from kbbl's `result` event.

    Unlike :class:`SessionSnapshot`, kbbl serializes ``ResultUsage``
    fields in snake_case (matching Anthropic's wire shape:
    ``input_tokens``, ``cache_creation_input_tokens``, etc.). No
    alias generator is applied here; field names are the wire names.
    """

    model_config = ConfigDict(extra="ignore")

    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int | None = None
    cache_read_input_tokens: int | None = None


class SessionSnapshot(_KbblModel):
    """Mirror of kbbl's ``PwaSessionSnapshot`` (the §14.1 browser wire).

    Nullable fields are typed as ``T | None`` but **without** a ``None``
    default, so a missing key in kbbl's response triggers a pydantic
    validation error rather than silently defaulting to ``None``. That
    keeps contract drift loud.
    """

    sid: str
    name: str
    agent_profile: str
    status: SessionStatus
    source: Literal["acp", "legacy_archive"]
    created_at: str
    last_activity_ts: str
    artifact_id: str | None
    project_workdir: str
    worktree_path: str
    worktree_branch: str | None
    worktree_base_ref: str | None
    requested_model: str | None
    requested_effort: str | None
    end_reason: str | None
    fenced_by: str | None
    pending_permission_count: int