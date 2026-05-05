"""Artifact version computation for OCC tokens.

A version is a content-derived hash that the mediator uses to detect
drift between an agent's read of the artifact and its later write.
PROSE artifacts hash the file's bytes; CODE artifacts are not yet
supported in the v1 incremental mode (raises so the caller can choose
to skip code projects or gate them upstream).
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from legit_biz_club.core.models import Artifact, ArtifactType


def compute_version(artifact: Artifact, *, content: str | None = None) -> str:
    """Compute an OCC token for the artifact's current state.

    When ``content`` is supplied, hashes that string directly — useful
    for callers that already have the bytes in hand and want a single
    consistent read of disk + version. When omitted, reads the artifact
    from disk and hashes the bytes (PROSE only).
    """
    if content is not None:
        return _hash_text(content)
    if artifact.type == ArtifactType.PROSE:
        return _hash_prose(artifact.path)
    if artifact.type == ArtifactType.CODE:
        raise NotImplementedError(
            "CODE incremental versioning is deferred; v1 incremental mode "
            "supports PROSE artifacts only"
        )
    raise ValueError(f"unknown artifact type: {artifact.type}")


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _hash_prose(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()
