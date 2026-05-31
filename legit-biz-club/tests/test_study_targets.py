"""Tests for study target factories."""
from __future__ import annotations

from legit_biz_club import (
    ArtifactType,
    Brief,
    TaskConfig,
    code_task,
    prose_task,
)
from legit_biz_club.study.targets import (
    TargetConfig,
    code_target,
    prose_target,
)
from legit_biz_club.study.targets import (
    code_task as module_code_task,
)
from legit_biz_club.study.targets import (
    prose_task as module_prose_task,
)


def test_prose_task_defaults() -> None:
    target = prose_task()
    assert isinstance(target, TaskConfig)
    assert target.artifact_type == ArtifactType.PROSE
    assert target.artifact_filename.endswith(".md")
    # Default brief has prose-shaped success criteria.
    assert isinstance(target.brief, Brief)
    assert target.brief.success_criteria
    # Model pool large enough to support n=7 with distinct models.
    assert len(target.model_pool) >= 7
    assert len(set(target.model_pool)) == len(target.model_pool)
    # Frame pool covers prose-relevant stances.
    assert "precision" in target.frame_pool
    assert "synthesis" in target.frame_pool


def test_code_task_defaults() -> None:
    target = code_task()
    assert target.artifact_type == ArtifactType.CODE
    assert target.artifact_filename.endswith(".py")
    assert "tests pass" in target.brief.success_criteria
    # Model pool large enough for n=7 heterogeneity.
    assert len(target.model_pool) >= 7
    assert len(set(target.model_pool)) == len(target.model_pool)
    # Code-relevant frames.
    assert "type-safety" in target.frame_pool


def test_prose_task_accepts_overrides() -> None:
    custom_brief = Brief(
        target_spec="custom",
        success_criteria=["custom-criterion"],
    )
    target = prose_task(
        name="custom_prose",
        artifact_filename="post.md",
        seed_content="seed paragraph",
        brief=custom_brief,
        model_pool=("only-one-model",),
        frame_pool=("only-one-frame",),
    )
    assert target.name == "custom_prose"
    assert target.artifact_filename == "post.md"
    assert target.seed_content == "seed paragraph"
    assert target.brief is custom_brief
    assert target.model_pool == ("only-one-model",)
    assert target.frame_pool == ("only-one-frame",)


def test_code_task_accepts_overrides() -> None:
    custom_brief = Brief(
        target_spec="implement X",
        success_criteria=["specific-test-passes"],
    )
    target = code_task(
        name="custom_code",
        artifact_filename="impl.py",
        seed_content="",
        brief=custom_brief,
        model_pool=("a", "b"),
    )
    assert target.name == "custom_code"
    assert target.brief.target_spec == "implement X"
    assert target.model_pool == ("a", "b")


def test_targets_are_immutable() -> None:
    """TaskConfig is frozen — runtime mutation would let one cell's
    customizations bleed into another."""
    target = prose_task()
    import dataclasses

    with __import__("pytest").raises(dataclasses.FrozenInstanceError):
        target.name = "mutated"  # type: ignore[misc]


def test_compatibility_aliases_remain_available() -> None:
    assert TargetConfig is TaskConfig
    assert prose_target is prose_task
    assert code_target is code_task
    assert module_prose_task is prose_task
    assert module_code_task is code_task
