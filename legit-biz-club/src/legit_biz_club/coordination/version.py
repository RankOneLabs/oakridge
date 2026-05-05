"""Artifact version computation for OCC tokens.

A version is a content-derived hash that the mediator uses to detect
drift between an agent's read of the artifact and its later write.

v1 supports **file-based artifacts** of either type — PROSE markdown
files and single-file CODE artifacts (one .py / .ts / etc) both hash
their bytes via the same code path. Directory-based CODE artifacts
(per the design memo's "next state = next commit" semantics) are
deferred to v1.x and raise here; that path needs git-aware versioning
which is its own design decision.

The artifact's :attr:`type` tags semantic intent (operator UI, eval
choice) but doesn't change the versioning strategy in v1 — the
underlying ``path`` does.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from legit_biz_club.core.models import Artifact, ArtifactType


def compute_version(artifact: Artifact, *, content: str | None = None) -> str:
    """Compute an OCC token for the artifact's current state.

    When ``content`` is supplied, hashes that string directly — useful
    for callers that already have the bytes in hand and want a single
    consistent read of disk + version.

    Artifact-type validation runs first so callers with content for
    an artifact type that's structurally unsupported (directory-based
    CODE) still hit ``NotImplementedError`` rather than silently
    getting a hash through the content shortcut.
    """
    if artifact.type not in {ArtifactType.PROSE, ArtifactType.CODE}:
        raise ValueError(f"unknown artifact type: {artifact.type}")
    if (
        artifact.type == ArtifactType.CODE
        and artifact.path.exists()
        and artifact.path.is_dir()
    ):
        raise NotImplementedError(
            "directory-based CODE artifacts use git-commit versioning, "
            "which is deferred to v1.x. v1 supports single-file CODE "
            "artifacts (the path resolves to one file)."
        )
    if content is not None:
        return _hash_text(content)
    return _hash_file(artifact.path)


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()
