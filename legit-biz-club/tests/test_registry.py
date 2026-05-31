"""Tests for legit_biz_club.study.registry.

Locks the registry data and the canonical_condition_name naming-parity
contract that cohort 3 reproduces in TypeScript. No real LLM calls.
"""
from __future__ import annotations

import pytest

from legit_biz_club import ArtifactType
from legit_biz_club.study.registry import (
    CONDITION_FACTORIES,
    GRADER_CATALOG,
    TARGET_FACTORIES,
    TASK_CATALOG,
    TASK_FACTORIES,
    canonical_condition_name,
    grader_factory_for,
    grader_metadata_for,
    task_summary_for,
)

# --- task factories / catalog ---


def test_all_five_task_keys_present() -> None:
    expected = {
        "prose_substrate_thesis",
        "code_leetcode_longest_substring",
        "code_leetcode_trapping_rain_water",
        "code_leetcode_regex_matching",
        "code_leetcode_median_two_sorted_arrays",
    }
    assert set(TASK_FACTORIES) == expected
    assert TARGET_FACTORIES is TASK_FACTORIES


@pytest.mark.parametrize("key", list(TASK_FACTORIES))
def test_factory_returns_task_config_whose_name_equals_key(key: str) -> None:
    task = TASK_FACTORIES[key]()
    assert task.name == key


def test_task_catalog_matches_registered_factories() -> None:
    assert tuple(entry.name for entry in TASK_CATALOG) == tuple(TASK_FACTORIES)
    for entry in TASK_CATALOG:
        assert entry.source == "builtin"
        assert entry.has_grader is True
        assert entry.grader_key == entry.name
        assert entry.artifact_type in (ArtifactType.PROSE, ArtifactType.CODE)


@pytest.mark.parametrize("key", list(TASK_FACTORIES))
def test_task_summary_lookup_round_trips(key: str) -> None:
    summary = task_summary_for(key)
    assert summary.name == key
    assert summary == TASK_CATALOG[list(TASK_FACTORIES).index(key)]


def test_unknown_task_summary_raises() -> None:
    with pytest.raises(ValueError):
        task_summary_for("not_a_real_task")


# --- condition factories ---


def test_all_four_condition_kinds_present() -> None:
    expected = {
        "single_agent",
        "ensemble_incremental",
        "ensemble_single_round",
        "ensemble_multi_round",
    }
    assert set(CONDITION_FACTORIES) == expected


def test_single_agent_factory_ignores_n() -> None:
    c = CONDITION_FACTORIES["single_agent"](n=99)
    assert c.name == "single_agent"
    assert c.n == 1


@pytest.mark.parametrize("n", [1, 2, 3, 5])
def test_ensemble_incremental_n(n: int) -> None:
    c = CONDITION_FACTORIES["ensemble_incremental"](n=n)
    assert c.name == f"ensemble_incremental_n{n}"
    assert c.n == n


@pytest.mark.parametrize("n", [2, 3, 5])
def test_ensemble_single_round_n(n: int) -> None:
    c = CONDITION_FACTORIES["ensemble_single_round"](n=n)
    assert c.name == f"ensemble_single_round_n{n}"
    assert c.n == n


def test_ensemble_single_round_rejects_n1() -> None:
    with pytest.raises(ValueError):
        CONDITION_FACTORIES["ensemble_single_round"](n=1)


@pytest.mark.parametrize("n", [2, 3, 5])
def test_ensemble_multi_round_n(n: int) -> None:
    c = CONDITION_FACTORIES["ensemble_multi_round"](n=n)
    assert c.name == f"ensemble_multi_round_n{n}"
    assert c.n == n


def test_ensemble_multi_round_rejects_n1() -> None:
    with pytest.raises(ValueError):
        CONDITION_FACTORIES["ensemble_multi_round"](n=1)


# --- canonical_condition_name ---


@pytest.mark.parametrize("n", [1, 2, 3, 5])
def test_canonical_single_agent_ignores_n(n: int) -> None:
    assert canonical_condition_name("single_agent", n) == "single_agent"


@pytest.mark.parametrize("n", [1, 2, 3, 5])
def test_canonical_ensemble_incremental(n: int) -> None:
    name = canonical_condition_name("ensemble_incremental", n)
    assert name == f"ensemble_incremental_n{n}"


@pytest.mark.parametrize("n", [1, 2, 3, 5])
def test_canonical_ensemble_single_round(n: int) -> None:
    name = canonical_condition_name("ensemble_single_round", n)
    assert name == f"ensemble_single_round_n{n}"


@pytest.mark.parametrize("n", [1, 2, 3, 5])
def test_canonical_ensemble_multi_round(n: int) -> None:
    name = canonical_condition_name("ensemble_multi_round", n)
    assert name == f"ensemble_multi_round_n{n}"


def test_canonical_unknown_kind_raises() -> None:
    with pytest.raises(ValueError):
        canonical_condition_name("unknown_kind", 3)


@pytest.mark.parametrize(
    "kind,n",
    [
        ("ensemble_incremental", 2),
        ("ensemble_single_round", 3),
        ("ensemble_multi_round", 5),
    ],
)
def test_canonical_name_matches_factory_produced_name(kind: str, n: int) -> None:
    factory_name = CONDITION_FACTORIES[kind](n=n).name
    assert canonical_condition_name(kind, n) == factory_name


def test_single_agent_canonical_matches_factory() -> None:
    factory_name = CONDITION_FACTORIES["single_agent"](n=5).name
    assert canonical_condition_name("single_agent", 5) == factory_name


# --- grader_factory_for ---


def test_all_five_grader_keys_present() -> None:
    expected = {
        "prose_substrate_thesis",
        "code_leetcode_longest_substring",
        "code_leetcode_trapping_rain_water",
        "code_leetcode_regex_matching",
        "code_leetcode_median_two_sorted_arrays",
    }
    assert {entry.key for entry in GRADER_CATALOG} == expected


def test_grader_catalog_tracks_capabilities() -> None:
    by_key = {entry.key: entry for entry in GRADER_CATALOG}
    prose = by_key["prose_substrate_thesis"]
    assert prose.supported_artifact_types == (ArtifactType.PROSE,)
    assert "brief-criteria" in prose.capabilities

    median = by_key["code_leetcode_median_two_sorted_arrays"]
    assert median.supported_artifact_types == (ArtifactType.CODE,)
    assert "perf" in median.capabilities


@pytest.mark.parametrize("key", list(TASK_FACTORIES))
def test_grader_metadata_lookup_round_trips(key: str) -> None:
    metadata = grader_metadata_for(key)
    assert metadata.key == key


def test_unknown_grader_metadata_raises() -> None:
    with pytest.raises(ValueError):
        grader_metadata_for("not_a_real_grader")


@pytest.mark.parametrize(
    "key",
    [
        "prose_substrate_thesis",
        "code_leetcode_longest_substring",
        "code_leetcode_trapping_rain_water",
        "code_leetcode_regex_matching",
        "code_leetcode_median_two_sorted_arrays",
    ],
)
def test_returns_callable_for_all_targets(key: str) -> None:
    factory = grader_factory_for(key)
    assert callable(factory)


def test_prose_accepts_judge_llm_none() -> None:
    factory = grader_factory_for("prose_substrate_thesis", judge_llm=None)
    assert callable(factory)


def test_unknown_target_raises() -> None:
    with pytest.raises(ValueError):
        grader_factory_for("not_a_real_target")
