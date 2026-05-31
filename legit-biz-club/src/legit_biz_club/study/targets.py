"""Task factories for the prose and code domains in the v1 study.

A :class:`TaskConfig` is a lightweight template describing one study
domain: the brief (target_spec / success_criteria / constraints), the
seed artifact content, and the model pool the runner draws from when
constructing the ensemble's agents.

The runner combines a task with a condition (n + protocol + mechanism)
to materialize a full :class:`Project`. Tasks don't yet know the
ensemble size — that's the condition's job.

v1 ships two tasks per the design memo:

- :func:`prose_task` — drafting a short technical blog post end-to-end.
- :func:`code_task` — implementing a small but non-trivial feature.

Both factories accept overrides so the v1 study can specialize the
brief / seed / model pool per run without forking the templates. The
defaults are minimal placeholders — Workstream D (study execution)
will supply real briefs and seed artifacts.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from legit_biz_club.core.models import ArtifactType, Brief


@dataclass(frozen=True, slots=True)
class TaskConfig:
    """One study domain's template.

    ``model_pool`` is the rotation the runner picks from when
    constructing the ensemble. With ``len(model_pool) >= n``, every
    agent in the ensemble has a distinct model (heterogeneity by
    model identity, the design memo's mechanically-enforced axis).
    With ``len(model_pool) < n``, the runner cycles — operator opted
    out of the heterogeneity guarantee.
    """

    name: str
    artifact_type: ArtifactType
    artifact_filename: str
    seed_content: str
    brief: Brief
    model_pool: tuple[str, ...]
    frame_pool: tuple[str | None, ...] = field(default_factory=tuple)


_DEFAULT_PROSE_MODELS = (
    "claude-sonnet-4-5",
    "gpt-5-mini",
    "gemini-2.5-pro",
    "claude-opus-4-7",
    "gpt-5",
    "gemini-2.5-flash",
    "claude-haiku-4-5",
)


_DEFAULT_PROSE_FRAMES = (
    "precision",
    "skepticism",
    "synthesis",
    "user-empathy",
    "first-principles",
    "concision",
    "voice",
)


_DEFAULT_CODE_MODELS = (
    "claude-sonnet-4-5",
    "gpt-5",
    "claude-opus-4-7",
    "gemini-2.5-pro",
    "gpt-5-mini",
    "claude-haiku-4-5",
    "gemini-2.5-flash",
)


_DEFAULT_CODE_FRAMES = (
    "type-safety",
    "test-coverage",
    "minimalism",
    "defensive-programming",
    "performance",
    "readability",
    "explicit-errors",
)


def prose_task(
    *,
    name: str = "prose_blog_post",
    artifact_filename: str = "draft.md",
    seed_content: str = "",
    brief: Brief | None = None,
    model_pool: Sequence[str] | None = None,
    frame_pool: Sequence[str | None] | None = None,
) -> TaskConfig:
    """Prose domain: drafting a technical blog post end-to-end.

    Default brief and seed are placeholder; Workstream D supplies the
    real ones. Model pool defaults to a 7-model spread covering the
    three frontier providers (Anthropic, OpenAI, Google) so the
    heterogeneity-by-model-identity check passes for n up to 7.
    """
    return TaskConfig(
        name=name,
        artifact_type=ArtifactType.PROSE,
        artifact_filename=artifact_filename,
        seed_content=seed_content,
        brief=brief
        or Brief(
            target_spec=(
                "Draft a technical blog post explaining the "
                "multi-agent workspace architecture to a software "
                "engineering audience."
            ),
            success_criteria=[
                "explains the substrate-mediated coordination claim",
                "describes the three coordination modes",
                "is under 1500 words",
                "uses concrete examples rather than abstractions",
            ],
            constraints=["no marketing language"],
        ),
        model_pool=(
            tuple(model_pool) if model_pool is not None else _DEFAULT_PROSE_MODELS
        ),
        frame_pool=(
            tuple(frame_pool) if frame_pool is not None else _DEFAULT_PROSE_FRAMES
        ),
    )


def code_task(
    *,
    name: str = "code_jig_feature",
    artifact_filename: str = "feature.py",
    seed_content: str = "",
    brief: Brief | None = None,
    model_pool: Sequence[str] | None = None,
    frame_pool: Sequence[str | None] | None = None,
) -> TaskConfig:
    """Code domain: implementing a small but non-trivial feature.

    v1 supports **single-file CODE artifacts only** — the artifact is
    one file (e.g., ``feature.py``), and incremental coordination
    treats it the same way it treats a PROSE markdown file (full-file
    rewrites with content-hash versioning). Directory-based CODE
    artifacts with git-commit semantics (per the design memo's
    "next state = next commit" framing) need git-aware versioning
    and are deferred to v1.x — see :mod:`legit_biz_club.coordination.version`.

    Default brief and seed are placeholder; Workstream D supplies the
    real ones. Model pool favors models with strong code-generation
    reputations; frames cover orthogonal code-quality stances.
    """
    return TaskConfig(
        name=name,
        artifact_type=ArtifactType.CODE,
        artifact_filename=artifact_filename,
        seed_content=seed_content,
        brief=brief
        or Brief(
            target_spec=(
                "Implement a small feature in the target codebase. "
                "Specifics will be provided per study run."
            ),
            success_criteria=[
                "tests pass",
                "type-check passes (mypy strict)",
                "lint passes (ruff)",
            ],
            constraints=[
                "no new third-party dependencies",
                "no breaking changes to existing public APIs",
            ],
        ),
        model_pool=(
            tuple(model_pool) if model_pool is not None else _DEFAULT_CODE_MODELS
        ),
        frame_pool=(
            tuple(frame_pool) if frame_pool is not None else _DEFAULT_CODE_FRAMES
        ),
    )


# Compatibility aliases for older callers. New code should import the
# task-named APIs above; these remain only so the existing registry /
# parsing bridges and older tests keep working while the migration lands.
TargetConfig = TaskConfig
prose_target = prose_task
code_target = code_task
