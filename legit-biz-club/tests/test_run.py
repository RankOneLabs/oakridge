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
    "task": "prose_substrate_thesis",
    "model_pool": ["claude-sonnet-4-5"],
    "condition": {"kind": "single_agent", "n": 1},
}


def _spec(**overrides: object) -> dict[str, object]:
    base = dict(_VALID_BASE)
    if "target" in overrides:
        base.pop("task", None)
    if "task" in overrides:
        base.pop("target", None)
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Resolution: every target key resolves to the right TargetConfig
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("key", list(registry.TARGET_FACTORIES))
def test_target_name_matches_key(key: str) -> None:
    spec = RunSpec.from_dict(_spec(target=key))
    assert spec.task == key
    target = registry.TARGET_FACTORIES[spec.task]()
    assert target.name == key


@pytest.mark.parametrize("key", list(registry.TARGET_FACTORIES))
def test_grader_factory_resolves_for_all_targets(key: str) -> None:
    spec = RunSpec.from_dict(_spec(target=key))
    grader = registry.grader_factory_for(spec.task)
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
# New task field / local task resolution
# ---------------------------------------------------------------------------


def _write_local_task_dir(tmp_path: Path, name: str, *, artifact_type: str) -> Path:
    local_task_dir = tmp_path / "local_tasks"
    local_task_dir.mkdir()
    local_task = {
        "name": name,
        "artifact_type": artifact_type,
        "artifact_filename": "draft.md" if artifact_type == "prose" else "impl.py",
        "seed_content": "seed",
        "brief": {
            "target_spec": "ship a thing",
            "success_criteria": ["it ships"],
            "constraints": ["be concise"],
        },
        "model_pool": ["claude-sonnet-4-5"],
        "frame_pool": ["precision"],
    }
    (local_task_dir / f"{name}.json").write_text(
        json.dumps(local_task),
        encoding="utf-8",
    )
    return local_task_dir


def _write_local_task_file(
    local_task_dir: Path, filename: str, task: dict[str, object]
) -> None:
    (local_task_dir / filename).write_text(json.dumps(task), encoding="utf-8")


def test_task_field_parses_new_run_spec_shape(tmp_path: Path) -> None:
    local_task_dir = _write_local_task_dir(
        tmp_path, "custom_prose", artifact_type="prose"
    )
    spec = RunSpec.from_dict(
        {
            "task": "custom_prose",
            "model_pool": ["claude-sonnet-4-5"],
            "condition": {"kind": "single_agent", "n": 1},
            "grade": False,
            "local_task_dir": str(local_task_dir),
        }
    )
    task = spec.resolve_task()
    assert spec.task == "custom_prose"
    assert spec.target == "custom_prose"
    assert task.name == "custom_prose"
    assert task.artifact_filename == "draft.md"


def test_legacy_target_parsing_remains_compatible() -> None:
    spec = RunSpec.from_dict(
        {
            "target": "prose_substrate_thesis",
            "model_pool": ["claude-sonnet-4-5"],
            "condition": {"kind": "single_agent", "n": 1},
        }
    )
    assert spec.task == "prose_substrate_thesis"
    assert spec.target == "prose_substrate_thesis"


def test_grade_true_rejects_local_task_without_grader(tmp_path: Path) -> None:
    local_task_dir = _write_local_task_dir(
        tmp_path, "custom_prose", artifact_type="prose"
    )
    spec = RunSpec.from_dict(
        {
            "task": "custom_prose",
            "model_pool": ["claude-sonnet-4-5"],
            "condition": {"kind": "single_agent", "n": 1},
            "grade": True,
            "local_task_dir": str(local_task_dir),
        }
    )
    task = spec.resolve_task()
    with pytest.raises(ValueError, match="grade=true requires a grader"):
        spec.resolve_grader(task)


def test_grade_false_skips_grader_resolution(tmp_path: Path) -> None:
    local_task_dir = _write_local_task_dir(
        tmp_path, "custom_prose", artifact_type="prose"
    )
    spec = RunSpec.from_dict(
        {
            "task": "custom_prose",
            "model_pool": ["claude-sonnet-4-5"],
            "condition": {"kind": "single_agent", "n": 1},
            "grade": False,
            "local_task_dir": str(local_task_dir),
        }
    )
    task = spec.resolve_task()
    assert spec.resolve_grader(task) is None


def test_local_task_name_collisions_are_rejected(tmp_path: Path) -> None:
    local_task_dir = tmp_path / "local_tasks"
    local_task_dir.mkdir()
    _write_local_task_file(
        local_task_dir,
        "builtin.json",
        {
            "name": "prose_substrate_thesis",
            "artifact_type": "prose",
            "artifact_filename": "draft.md",
            "seed_content": "seed",
            "brief": {
                "target_spec": "ship a thing",
                "success_criteria": ["it ships"],
            },
            "model_pool": ["claude-sonnet-4-5"],
        },
    )
    with pytest.raises(ValueError, match="collides with built-in task names"):
        RunSpec.from_dict(
            {
                "task": "prose_substrate_thesis",
                "model_pool": ["claude-sonnet-4-5"],
                "condition": {"kind": "single_agent", "n": 1},
                "local_task_dir": str(local_task_dir),
            }
        )


def test_local_task_invalid_name_is_rejected(tmp_path: Path) -> None:
    local_task_dir = tmp_path / "local_tasks"
    local_task_dir.mkdir()
    _write_local_task_file(
        local_task_dir,
        "bad.json",
        {
            "name": "1bad",
            "artifact_type": "prose",
            "artifact_filename": "draft.md",
            "seed_content": "seed",
            "brief": {
                "target_spec": "ship a thing",
                "success_criteria": ["it ships"],
            },
            "model_pool": ["claude-sonnet-4-5"],
        },
    )
    with pytest.raises(ValueError, match="snake_case"):
        RunSpec.from_dict(
            {
                "task": "1bad",
                "model_pool": ["claude-sonnet-4-5"],
                "condition": {"kind": "single_agent", "n": 1},
                "local_task_dir": str(local_task_dir),
            }
        )


def test_local_task_invalid_artifact_filename_is_rejected(tmp_path: Path) -> None:
    local_task_dir = tmp_path / "local_tasks"
    local_task_dir.mkdir()
    _write_local_task_file(
        local_task_dir,
        "bad.json",
        {
            "name": "bad_task",
            "artifact_type": "prose",
            "artifact_filename": "subdir/draft.md",
            "seed_content": "seed",
            "brief": {
                "target_spec": "ship a thing",
                "success_criteria": ["it ships"],
            },
            "model_pool": ["claude-sonnet-4-5"],
        },
    )
    with pytest.raises(ValueError, match="bare filename"):
        RunSpec.from_dict(
            {
                "task": "bad_task",
                "model_pool": ["claude-sonnet-4-5"],
                "condition": {"kind": "single_agent", "n": 1},
                "local_task_dir": str(local_task_dir),
            }
        )


def test_registered_grader_ref_resolves_for_compatible_task() -> None:
    spec = RunSpec.from_dict(
        {
            "task": "prose_substrate_thesis",
            "model_pool": ["claude-sonnet-4-5"],
            "condition": {"kind": "single_agent", "n": 1},
            "grader": {
                "kind": "registered",
                "key": "prose_substrate_thesis",
            },
        }
    )
    task = spec.resolve_task()
    grader = spec.resolve_grader(task)
    assert callable(grader)


def test_unknown_grader_ref_is_rejected() -> None:
    # Use a local task so the lookup reaches registry.grader_metadata_for(...)
    # instead of failing earlier on the built-in task/grader mismatch guard.
    # This keeps the test covering the "unknown grader metadata" case.
    #
    # The helper only writes the task file; the task name stays local.
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        local_task_dir = Path(d) / "local_tasks"
        local_task_dir.mkdir()
        _write_local_task_file(
            local_task_dir,
            "custom.json",
            {
                "name": "custom_prose",
                "artifact_type": "prose",
                "artifact_filename": "draft.md",
                "seed_content": "seed",
                "brief": {
                    "target_spec": "ship a thing",
                    "success_criteria": ["it ships"],
                },
                "model_pool": ["claude-sonnet-4-5"],
            },
        )
        spec = RunSpec.from_dict(
            {
                "task": "custom_prose",
                "model_pool": ["claude-sonnet-4-5"],
                "condition": {"kind": "single_agent", "n": 1},
                "grader": {"kind": "registered", "key": "not_a_real_grader"},
                "local_task_dir": str(local_task_dir),
            }
        )
        task = spec.resolve_task()
        with pytest.raises(ValueError, match="no grader metadata"):
            spec.resolve_grader(task)


def test_incompatible_grader_ref_is_rejected() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        local_task_dir = Path(d) / "local_tasks"
        local_task_dir.mkdir()
        _write_local_task_file(
            local_task_dir,
            "custom.json",
            {
                "name": "custom_prose",
                "artifact_type": "prose",
                "artifact_filename": "draft.md",
                "seed_content": "seed",
                "brief": {
                    "target_spec": "ship a thing",
                    "success_criteria": ["it ships"],
                },
                "model_pool": ["claude-sonnet-4-5"],
            },
        )
        spec = RunSpec.from_dict(
            {
                "task": "custom_prose",
                "model_pool": ["claude-sonnet-4-5"],
                "condition": {"kind": "single_agent", "n": 1},
                "grader": {
                    "kind": "registered",
                    "key": "code_leetcode_longest_substring",
                },
                "local_task_dir": str(local_task_dir),
            }
        )
        task = spec.resolve_task()
        with pytest.raises(ValueError, match="does not support artifact type"):
            spec.resolve_grader(task)


def test_builtin_task_rejects_wrong_registered_grader_key() -> None:
    spec = RunSpec.from_dict(
        {
            "task": "code_leetcode_regex_matching",
            "model_pool": ["claude-sonnet-4-5"],
            "condition": {"kind": "single_agent", "n": 1},
            "grader": {
                "kind": "registered",
                "key": "code_leetcode_longest_substring",
            },
        }
    )
    task = spec.resolve_task()
    with pytest.raises(ValueError, match="requires registered grader"):
        spec.resolve_grader(task)


def test_local_grader_config_resolves_registered_grader(
    tmp_path: Path,
) -> None:
    local_grader_config_dir = tmp_path / "grader_configs"
    local_grader_config_dir.mkdir()
    (local_grader_config_dir / "prose.json").write_text(
        json.dumps(
            {
                "key": "prose_substrate_thesis",
                "config": {"ignored": True},
            }
        ),
        encoding="utf-8",
    )
    spec = RunSpec.from_dict(
        {
            "task": "prose_substrate_thesis",
            "model_pool": ["claude-sonnet-4-5"],
            "condition": {"kind": "single_agent", "n": 1},
            "grader": {"kind": "local_config", "name": "prose"},
            "local_grader_config_dir": str(local_grader_config_dir),
        }
    )
    task = spec.resolve_task()
    grader = spec.resolve_grader(task)
    assert callable(grader)


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
