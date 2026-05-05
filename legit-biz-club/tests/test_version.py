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


def test_code_directory_artifact_raises(tmp_path: Path) -> None:
    """Directory-based CODE artifacts (git-commit semantics) are
    deferred to v1.x — single-file CODE works, directory does not."""
    code_dir = tmp_path / "code"
    code_dir.mkdir()
    artifact = Artifact(type=ArtifactType.CODE, path=code_dir)
    with pytest.raises(NotImplementedError, match="directory-based CODE"):
        compute_version(artifact)


def test_code_directory_with_content_still_raises(tmp_path: Path) -> None:
    """Same defense via the content shortcut — a caller with content
    in hand for a directory-CODE artifact still hits the deferred
    path."""
    code_dir = tmp_path / "code"
    code_dir.mkdir()
    artifact = Artifact(type=ArtifactType.CODE, path=code_dir)
    with pytest.raises(NotImplementedError, match="directory-based CODE"):
        compute_version(artifact, content="some bytes")


def test_code_single_file_hashes_like_prose(tmp_path: Path) -> None:
    """v1 supports single-file CODE artifacts — content-hash versioning
    works the same as for PROSE markdown."""
    p = tmp_path / "feature.py"
    p.write_text("def hello(): return 1\n", encoding="utf-8")
    artifact = Artifact(type=ArtifactType.CODE, path=p)
    version = compute_version(artifact)
    # Same hash as the equivalent prose file with the same bytes.
    prose_artifact = Artifact(type=ArtifactType.PROSE, path=p)
    assert version == compute_version(prose_artifact)


def test_code_single_file_with_content_kwarg(tmp_path: Path) -> None:
    """Content shortcut works for single-file CODE artifacts too."""
    p = tmp_path / "feature.py"
    p.write_text("seed", encoding="utf-8")
    artifact = Artifact(type=ArtifactType.CODE, path=p)
    v_explicit = compute_version(artifact, content="explicit content")
    v_disk = compute_version(artifact)
    assert v_explicit != v_disk
