"""Tests for the v1 study target factories.

These are smoke-shaped tests — they verify the briefs build cleanly,
ship the architectural anchors that keep models from inventing
modes, and pin the artifact filenames. Brief-content quality is a
research question, not something pytest can settle.
"""
from __future__ import annotations

from legit_biz_club import ArtifactType, Brief
from legit_biz_club.study.targets import TaskConfig
from legit_biz_club.study.v1_targets import (
    code_leetcode_longest_substring,
    prose_substrate_thesis,
)


def test_prose_substrate_thesis_builds_a_real_target() -> None:
    target = prose_substrate_thesis()
    assert isinstance(target, TaskConfig)
    assert target.name == "prose_substrate_thesis"
    assert target.artifact_type == ArtifactType.PROSE
    assert target.artifact_filename == "thesis.md"
    assert isinstance(target.brief, Brief)


def test_prose_substrate_thesis_brief_carries_architecture_anchors() -> None:
    """The whole point of this brief is to keep the model from
    inventing modes. The brief must name the three real coordination
    modes by their actual names, AND explicitly forbid the common
    invented ones, so a regression that silently weakens either
    guardrail is caught here."""
    target = prose_substrate_thesis()
    spec = target.brief.target_spec.lower()
    # Real modes named.
    assert "incremental" in spec
    assert "convergence" in spec
    assert "escalation" in spec
    # Common invented modes explicitly forbidden somewhere in the
    # brief (target_spec or constraints).
    forbidden_signal = " ".join(
        [target.brief.target_spec, *target.brief.constraints]
    ).lower()
    assert "do not invent" in forbidden_signal
    assert "sequential" in forbidden_signal
    assert "parallel" in forbidden_signal
    assert "hierarchical" in forbidden_signal


def test_code_leetcode_longest_substring_builds_a_real_target() -> None:
    target = code_leetcode_longest_substring()
    assert isinstance(target, TaskConfig)
    assert target.name == "code_leetcode_longest_substring"
    assert target.artifact_type == ArtifactType.CODE
    assert target.artifact_filename == "solution.py"
    # Seed is a function stub raising NotImplementedError so the
    # artifact starts in a known-broken state.
    assert "def length_of_longest_substring" in target.seed_content
    assert "NotImplementedError" in target.seed_content


def test_brief_lists_are_fresh_per_factory_call() -> None:
    """Pydantic Brief has mutable list fields. The factories build a
    new Brief each call so an in-place mutation by one caller can't
    leak into a subsequent caller's target. Without this test the
    refactor that cached Briefs at module level would be silently
    reintroducible."""
    a = prose_substrate_thesis()
    b = prose_substrate_thesis()
    assert a.brief is not b.brief
    a.brief.success_criteria.append("MUTATED")
    assert "MUTATED" not in b.brief.success_criteria

    c = code_leetcode_longest_substring()
    d = code_leetcode_longest_substring()
    assert c.brief is not d.brief
    c.brief.constraints.append("MUTATED")
    assert "MUTATED" not in d.brief.constraints


def test_code_leetcode_longest_substring_brief_pins_examples() -> None:
    """Without inline examples the model has to infer the spec — and
    leetcode #3 has well-known input/output pairs that anchor the
    expected behavior. A regression that drops the examples block
    silently tanks correctness."""
    target = code_leetcode_longest_substring()
    spec = target.brief.target_spec
    # A handful of canonical examples should survive any rewrite.
    assert "abcabcbb" in spec
    assert "pwwkew" in spec
    assert "length_of_longest_substring" in spec
