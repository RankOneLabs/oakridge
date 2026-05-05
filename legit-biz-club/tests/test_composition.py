"""Composition policy and heterogeneity check tests.

Cover the silent-skip-below-threshold rule (n<3), the three axes, the
binding-uniqueness path via Enrollment, and the homogeneous escape
hatch.
"""
from __future__ import annotations

from pathlib import Path

from legit_biz_club import (
    Agent,
    CompositionMode,
    CompositionPolicy,
    Enrollment,
    HeterogeneityAxis,
    check_heterogeneity,
)


def _agent(
    name: str,
    model: str,
    *,
    frame: str | None = None,
    db_dir: Path,
) -> Agent:
    return Agent(
        name=name,
        model=model,
        system_prompt=f"you are {name}",
        frame=frame,
        memory_db_path=db_dir / f"{name}.db",
    )


def test_skip_below_three_agents(tmp_path: Path) -> None:
    agents = [
        _agent("a", "claude-sonnet-4-5", db_dir=tmp_path),
        _agent("b", "claude-sonnet-4-5", db_dir=tmp_path),  # would dupe at n>=3
    ]
    policy = CompositionPolicy()
    assert check_heterogeneity(agents, [], policy) == []


def test_homogeneous_skips_all_axes(tmp_path: Path) -> None:
    agents = [
        _agent("a", "claude-sonnet-4-5", db_dir=tmp_path),
        _agent("b", "claude-sonnet-4-5", db_dir=tmp_path),
        _agent("c", "claude-sonnet-4-5", db_dir=tmp_path),
    ]
    policy = CompositionPolicy(mode=CompositionMode.HOMOGENEOUS)
    assert check_heterogeneity(agents, [], policy) == []


def test_model_identity_violation(tmp_path: Path) -> None:
    agents = [
        _agent("a", "claude-sonnet-4-5", db_dir=tmp_path),
        _agent("b", "claude-sonnet-4-5", db_dir=tmp_path),
        _agent("c", "gpt-5-mini", db_dir=tmp_path),
    ]
    policy = CompositionPolicy(
        enforced_axes=[HeterogeneityAxis.MODEL_IDENTITY],
    )
    violations = check_heterogeneity(agents, [], policy)
    assert len(violations) == 1
    assert violations[0].axis == HeterogeneityAxis.MODEL_IDENTITY
    assert violations[0].duplicate_value == "claude-sonnet-4-5"
    assert sorted(violations[0].affected_agent_ids) == sorted(
        [agents[0].id, agents[1].id]
    )


def test_distinct_models_pass(tmp_path: Path) -> None:
    agents = [
        _agent("a", "claude-sonnet-4-5", db_dir=tmp_path),
        _agent("b", "gpt-5-mini", db_dir=tmp_path),
        _agent("c", "gemini-2.5-pro", db_dir=tmp_path),
    ]
    policy = CompositionPolicy(
        enforced_axes=[HeterogeneityAxis.MODEL_IDENTITY],
    )
    assert check_heterogeneity(agents, [], policy) == []


def test_frame_skips_agents_without_frame(tmp_path: Path) -> None:
    """Honor-system frame check: agents with no frame don't violate.

    Two agents share frame "precision" — that's a violation. The third
    has no frame — it's not pulled into the comparison.
    """
    agents = [
        _agent("a", "claude-sonnet-4-5", frame="precision", db_dir=tmp_path),
        _agent("b", "gpt-5-mini", frame="precision", db_dir=tmp_path),
        _agent("c", "gemini-2.5-pro", db_dir=tmp_path),
    ]
    policy = CompositionPolicy(
        enforced_axes=[HeterogeneityAxis.SYSTEM_PROMPT_FRAME],
    )
    violations = check_heterogeneity(agents, [], policy)
    assert len(violations) == 1
    assert violations[0].axis == HeterogeneityAxis.SYSTEM_PROMPT_FRAME
    assert violations[0].duplicate_value == "precision"


def test_binding_uniqueness(tmp_path: Path) -> None:
    """Binding violations come from the enrollment side, not the agent side."""
    agents = [
        _agent("a", "claude-sonnet-4-5", db_dir=tmp_path),
        _agent("b", "gpt-5-mini", db_dir=tmp_path),
        _agent("c", "gemini-2.5-pro", db_dir=tmp_path),
    ]
    enrollments = [
        Enrollment(agent_id=agents[0].id, project_id="p-1", binding={"section": "intro"}),
        Enrollment(agent_id=agents[1].id, project_id="p-1", binding={"section": "intro"}),
        Enrollment(agent_id=agents[2].id, project_id="p-1", binding={"section": "outro"}),
    ]
    policy = CompositionPolicy(
        enforced_axes=[HeterogeneityAxis.BINDING],
    )
    violations = check_heterogeneity(agents, enrollments, policy)
    assert len(violations) == 1
    assert violations[0].axis == HeterogeneityAxis.BINDING


def test_binding_unaffected_by_key_order(tmp_path: Path) -> None:
    """{a:1,b:2} and {b:2,a:1} hash to the same binding key."""
    agents = [
        _agent("a", "claude-sonnet-4-5", db_dir=tmp_path),
        _agent("b", "gpt-5-mini", db_dir=tmp_path),
        _agent("c", "gemini-2.5-pro", db_dir=tmp_path),
    ]
    enrollments = [
        Enrollment(
            agent_id=agents[0].id,
            project_id="p-1",
            binding={"a": 1, "b": 2},
        ),
        Enrollment(
            agent_id=agents[1].id,
            project_id="p-1",
            binding={"b": 2, "a": 1},
        ),
        Enrollment(agent_id=agents[2].id, project_id="p-1", binding={"a": 9}),
    ]
    policy = CompositionPolicy(
        enforced_axes=[HeterogeneityAxis.BINDING],
    )
    violations = check_heterogeneity(agents, enrollments, policy)
    assert len(violations) == 1


def test_empty_axes_disables_check(tmp_path: Path) -> None:
    agents = [
        _agent("a", "claude-sonnet-4-5", db_dir=tmp_path),
        _agent("b", "claude-sonnet-4-5", db_dir=tmp_path),
        _agent("c", "claude-sonnet-4-5", db_dir=tmp_path),
    ]
    policy = CompositionPolicy(enforced_axes=[])
    assert check_heterogeneity(agents, [], policy) == []
