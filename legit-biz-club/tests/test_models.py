"""Smoke tests for the data model.

Verify defaults, validators, and that pydantic accepts plausible
construction patterns. Behavioral logic (lifecycle, composition) is
tested separately.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from legit_biz_club import (
    Agent,
    Artifact,
    ArtifactType,
    Brief,
    Enrollment,
    Project,
    ProjectState,
)


def test_artifact_resolves_path(tmp_path: Path) -> None:
    artifact = Artifact(type=ArtifactType.PROSE, path=tmp_path / "post.md")
    assert artifact.path.is_absolute()
    assert artifact.id  # default-factory populates


def test_artifact_rejects_invalid_type() -> None:
    with pytest.raises(ValidationError):
        Artifact(type="not-a-type", path=Path("/tmp/foo"))  # type: ignore[arg-type]


def test_brief_defaults_constraints_to_empty() -> None:
    brief = Brief(target_spec="ship a thing", success_criteria=["it ships"])
    assert brief.constraints == []


def test_agent_resolves_memory_path(tmp_path: Path) -> None:
    agent = Agent(
        name="alice",
        model="claude-sonnet-4-5",
        system_prompt="be precise",
        memory_db_path=tmp_path / "alice.db",
    )
    assert agent.memory_db_path.is_absolute()
    assert agent.frame is None


def test_enrollment_records_timestamp() -> None:
    e = Enrollment(agent_id="a-1", project_id="p-1")
    assert e.binding is None
    assert e.enrolled_at is not None


def test_project_starts_initialized(tmp_path: Path) -> None:
    project = Project(
        artifact=Artifact(type=ArtifactType.CODE, path=tmp_path),
        brief=Brief(target_spec="x", success_criteria=["y"]),
    )
    assert project.state == ProjectState.INITIALIZED
    assert project.enrollments == []
    assert project.shipped_at is None
    assert project.archived_at is None
