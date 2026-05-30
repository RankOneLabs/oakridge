"""Tests for legit_biz_club.run.

Covers resolution + validation only. No real LLM calls, no run_cell
end-to-end.
"""
from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest

from legit_biz_club.run import ConditionSpec, RunSpec, _build_event_tee
from legit_biz_club.study import registry

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_VALID_BASE: dict[str, object] = {
    "target": "prose_substrate_thesis",
    "model_pool": ["claude-sonnet-4-5"],
    "condition": {"kind": "single_agent", "n": 1},
}


def _spec(**overrides: object) -> dict[str, object]:
    return {**_VALID_BASE, **overrides}


# ---------------------------------------------------------------------------
# Resolution: every target key resolves to the right TargetConfig
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("key", list(registry.TARGET_FACTORIES))
def test_target_name_matches_key(key: str) -> None:
    spec = RunSpec.from_dict(_spec(target=key))
    target = registry.TARGET_FACTORIES[spec.target]()
    assert target.name == key


@pytest.mark.parametrize("key", list(registry.TARGET_FACTORIES))
def test_grader_factory_resolves_for_all_targets(key: str) -> None:
    spec = RunSpec.from_dict(_spec(target=key))
    grader = registry.grader_factory_for(spec.target)
    assert callable(grader)


def test_model_pool_override_lands_on_target() -> None:
    pool = ("model-a", "model-b")
    spec = RunSpec.from_dict(_spec(model_pool=list(pool)))
    target = registry.TARGET_FACTORIES[spec.target]()
    target_with_override = dataclasses.replace(target, model_pool=spec.model_pool)
    assert target_with_override.model_pool == pool


# ---------------------------------------------------------------------------
# Resolution: each condition kind builds the right ConditionConfig
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "kind,n,expected_name",
    [
        ("single_agent", 1, "single_agent"),
        ("ensemble_incremental", 3, "ensemble_incremental_n3"),
        ("ensemble_single_round", 2, "ensemble_single_round_n2"),
        ("ensemble_multi_round", 4, "ensemble_multi_round_n4"),
    ],
)
def test_condition_kind_produces_expected_name(
    kind: str, n: int, expected_name: str
) -> None:
    spec = RunSpec.from_dict(_spec(condition={"kind": kind, "n": n}))
    condition = registry.CONDITION_FACTORIES[spec.condition.kind](n=spec.condition.n)
    assert condition.name == expected_name


def test_condition_n_matches_spec() -> None:
    spec = RunSpec.from_dict(
        _spec(condition={"kind": "ensemble_incremental", "n": 5})
    )
    condition = registry.CONDITION_FACTORIES[spec.condition.kind](n=spec.condition.n)
    assert condition.n == 5


def test_single_agent_n_is_always_1() -> None:
    spec = RunSpec.from_dict(_spec(condition={"kind": "single_agent", "n": 1}))
    condition = registry.CONDITION_FACTORIES[spec.condition.kind](n=spec.condition.n)
    assert condition.n == 1


# ---------------------------------------------------------------------------
# Validation: n bounds
# ---------------------------------------------------------------------------


def test_n_zero_raises() -> None:
    with pytest.raises(ValueError):
        RunSpec.from_dict(_spec(condition={"kind": "ensemble_incremental", "n": 0}))


def test_n_negative_raises() -> None:
    with pytest.raises(ValueError):
        RunSpec.from_dict(_spec(condition={"kind": "ensemble_incremental", "n": -1}))


def test_n_17_raises() -> None:
    with pytest.raises(ValueError):
        RunSpec.from_dict(_spec(condition={"kind": "ensemble_incremental", "n": 17}))


def test_n_16_valid() -> None:
    spec = RunSpec.from_dict(
        _spec(condition={"kind": "ensemble_incremental", "n": 16})
    )
    assert spec.condition.n == 16


def test_n_1_valid() -> None:
    spec = RunSpec.from_dict(_spec(condition={"kind": "single_agent", "n": 1}))
    assert spec.condition.n == 1


# ---------------------------------------------------------------------------
# Validation: kind-specific n rules
# ---------------------------------------------------------------------------


def test_single_agent_n2_raises() -> None:
    with pytest.raises(ValueError, match="single_agent"):
        RunSpec.from_dict(_spec(condition={"kind": "single_agent", "n": 2}))


def test_ensemble_single_round_n1_raises() -> None:
    with pytest.raises(ValueError):
        RunSpec.from_dict(_spec(condition={"kind": "ensemble_single_round", "n": 1}))


def test_ensemble_multi_round_n1_raises() -> None:
    with pytest.raises(ValueError):
        RunSpec.from_dict(_spec(condition={"kind": "ensemble_multi_round", "n": 1}))


def test_ensemble_incremental_n1_valid() -> None:
    spec = RunSpec.from_dict(
        _spec(condition={"kind": "ensemble_incremental", "n": 1})
    )
    assert spec.condition == ConditionSpec(kind="ensemble_incremental", n=1)


# ---------------------------------------------------------------------------
# Validation: model_pool rules
# ---------------------------------------------------------------------------


def test_empty_model_pool_raises() -> None:
    with pytest.raises(ValueError, match="model_pool"):
        RunSpec.from_dict(_spec(model_pool=[]))


def test_empty_string_entry_raises() -> None:
    with pytest.raises(ValueError, match="non-empty string"):
        RunSpec.from_dict(_spec(model_pool=["", "claude-sonnet-4-5"]))


def test_empty_string_only_raises() -> None:
    with pytest.raises(ValueError):
        RunSpec.from_dict(_spec(model_pool=[""]))


def test_non_list_model_pool_raises() -> None:
    with pytest.raises(ValueError, match="model_pool"):
        RunSpec.from_dict(_spec(model_pool="claude-sonnet-4-5"))  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Validation: unknown target / kind
# ---------------------------------------------------------------------------


def test_unknown_target_raises() -> None:
    with pytest.raises(ValueError):
        RunSpec.from_dict(_spec(target="not_a_real_target"))


def test_unknown_kind_raises() -> None:
    with pytest.raises(ValueError, match="condition.kind"):
        RunSpec.from_dict(_spec(condition={"kind": "unknown_kind", "n": 1}))


# ---------------------------------------------------------------------------
# Validation: grade default and override
# ---------------------------------------------------------------------------


def test_grade_defaults_to_true() -> None:
    spec = RunSpec.from_dict(
        {
            "target": "prose_substrate_thesis",
            "model_pool": ["m"],
            "condition": {"kind": "single_agent", "n": 1},
        }
    )
    assert spec.grade is True


def test_grade_false_accepted() -> None:
    spec = RunSpec.from_dict(_spec(grade=False))
    assert spec.grade is False


def test_grade_non_bool_raises() -> None:
    with pytest.raises(ValueError, match="grade"):
        RunSpec.from_dict(_spec(grade=1))


# ---------------------------------------------------------------------------
# Event tee: shape check
# ---------------------------------------------------------------------------


async def test_tee_writes_expected_shape(tmp_path: Path) -> None:
    jsonl_path = tmp_path / "subdir" / "events.jsonl"
    tee = _build_event_tee(jsonl_path)
    await tee("test_kind", {"foo": "bar"})

    lines = jsonl_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert set(record.keys()) == {"ts", "kind", "payload"}
    assert record["kind"] == "test_kind"
    assert record["payload"] == {"foo": "bar"}
    assert isinstance(record["ts"], str) and record["ts"]


async def test_tee_creates_parent_dir(tmp_path: Path) -> None:
    jsonl_path = tmp_path / "deep" / "nested" / "events.jsonl"
    tee = _build_event_tee(jsonl_path)
    await tee("ping", {})
    assert jsonl_path.exists()


async def test_tee_appends_multiple_lines(tmp_path: Path) -> None:
    jsonl_path = tmp_path / "events.jsonl"
    tee = _build_event_tee(jsonl_path)
    await tee("a", {"n": 1})
    await tee("b", {"n": 2})
    lines = jsonl_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["kind"] == "a"
    assert json.loads(lines[1])["kind"] == "b"
