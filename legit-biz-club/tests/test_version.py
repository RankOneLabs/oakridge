"""Tests for OCC version computation."""
from __future__ import annotations

from pathlib import Path

import pytest

from legit_biz_club import Artifact, ArtifactType, compute_version


def _prose_artifact(tmp_path: Path, content: str) -> Artifact:
    p = tmp_path / "draft.md"
    p.write_text(content, encoding="utf-8")
    return Artifact(type=ArtifactType.PROSE, path=p)


def test_prose_version_stable_for_same_content(tmp_path: Path) -> None:
    artifact = _prose_artifact(tmp_path, "hello world")
    v1 = compute_version(artifact)
    v2 = compute_version(artifact)
    assert v1 == v2


def test_prose_version_changes_with_content(tmp_path: Path) -> None:
    artifact = _prose_artifact(tmp_path, "hello")
    v_hello = compute_version(artifact, content="hello")
    v_hello_bang = compute_version(artifact, content="hello!")
    assert v_hello != v_hello_bang


def test_explicit_content_overrides_disk(tmp_path: Path) -> None:
    artifact = _prose_artifact(tmp_path, "on disk")
    on_disk_version = compute_version(artifact)
    explicit_version = compute_version(artifact, content="something else")
    assert on_disk_version != explicit_version


def test_code_artifact_raises(tmp_path: Path) -> None:
    code_dir = tmp_path / "code"
    code_dir.mkdir()
    artifact = Artifact(type=ArtifactType.CODE, path=code_dir)
    with pytest.raises(NotImplementedError):
        compute_version(artifact)


def test_code_artifact_with_content_still_raises(tmp_path: Path) -> None:
    """The content shortcut must not bypass the artifact-type check —
    callers that have content for a CODE artifact should still hit
    NotImplementedError, not silently get a hash."""
    code_dir = tmp_path / "code"
    code_dir.mkdir()
    artifact = Artifact(type=ArtifactType.CODE, path=code_dir)
    with pytest.raises(NotImplementedError):
        compute_version(artifact, content="some bytes")
