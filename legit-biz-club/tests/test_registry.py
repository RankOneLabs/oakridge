"""Tests for legit_biz_club.study.registry.

Locks the registry data and the canonical_condition_name naming-parity
contract that cohort 3 reproduces in TypeScript. No real LLM calls.
"""
from __future__ import annotations

import pytest

from legit_biz_club.study.registry import (
    CONDITION_FACTORIES,
    TARGET_FACTORIES,
    canonical_condition_name,
    grader_factory_for,
)

# --- TARGET_FACTORIES ---


class TestTargetFactories:
    def test_all_five_keys_present(self) -> None:
        expected = {
            "prose_substrate_thesis",
            "code_leetcode_longest_substring",
            "code_leetcode_trapping_rain_water",
            "code_leetcode_regex_matching",
            "code_leetcode_median_two_sorted_arrays",
        }
        assert set(TARGET_FACTORIES) == expected

    @pytest.mark.parametrize("key", list(TARGET_FACTORIES))
    def test_factory_returns_target_config_whose_name_equals_key(
        self, key: str
    ) -> None:
        target = TARGET_FACTORIES[key]()
        assert target.name == key


# --- CONDITION_FACTORIES ---


class TestConditionFactories:
    def test_all_four_kinds_present(self) -> None:
        expected = {
            "single_agent",
            "ensemble_incremental",
            "ensemble_single_round",
            "ensemble_multi_round",
        }
        assert set(CONDITION_FACTORIES) == expected

    def test_single_agent_ignores_n(self) -> None:
        c = CONDITION_FACTORIES["single_agent"](n=99)
        assert c.name == "single_agent"
        assert c.n == 1

    @pytest.mark.parametrize("n", [1, 2, 3, 5])
    def test_ensemble_incremental_n(self, n: int) -> None:
        c = CONDITION_FACTORIES["ensemble_incremental"](n=n)
        assert c.name == f"ensemble_incremental_n{n}"
        assert c.n == n

    @pytest.mark.parametrize("n", [2, 3, 5])
    def test_ensemble_single_round_n(self, n: int) -> None:
        c = CONDITION_FACTORIES["ensemble_single_round"](n=n)
        assert c.name == f"ensemble_single_round_n{n}"
        assert c.n == n

    def test_ensemble_single_round_rejects_n1(self) -> None:
        with pytest.raises(ValueError):
            CONDITION_FACTORIES["ensemble_single_round"](n=1)

    @pytest.mark.parametrize("n", [2, 3, 5])
    def test_ensemble_multi_round_n(self, n: int) -> None:
        c = CONDITION_FACTORIES["ensemble_multi_round"](n=n)
        assert c.name == f"ensemble_multi_round_n{n}"
        assert c.n == n

    def test_ensemble_multi_round_rejects_n1(self) -> None:
        with pytest.raises(ValueError):
            CONDITION_FACTORIES["ensemble_multi_round"](n=1)


# --- canonical_condition_name ---


class TestCanonicalConditionName:
    @pytest.mark.parametrize("n", [1, 2, 3, 5])
    def test_single_agent_ignores_n(self, n: int) -> None:
        assert canonical_condition_name("single_agent", n) == "single_agent"

    @pytest.mark.parametrize("n", [1, 2, 3, 5])
    def test_ensemble_incremental(self, n: int) -> None:
        name = canonical_condition_name("ensemble_incremental", n)
        assert name == f"ensemble_incremental_n{n}"

    @pytest.mark.parametrize("n", [1, 2, 3, 5])
    def test_ensemble_single_round(self, n: int) -> None:
        name = canonical_condition_name("ensemble_single_round", n)
        assert name == f"ensemble_single_round_n{n}"

    @pytest.mark.parametrize("n", [1, 2, 3, 5])
    def test_ensemble_multi_round(self, n: int) -> None:
        name = canonical_condition_name("ensemble_multi_round", n)
        assert name == f"ensemble_multi_round_n{n}"

    def test_unknown_kind_raises(self) -> None:
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
    def test_canonical_name_matches_factory_produced_name(
        self, kind: str, n: int
    ) -> None:
        factory_name = CONDITION_FACTORIES[kind](n=n).name
        assert canonical_condition_name(kind, n) == factory_name

    def test_single_agent_canonical_matches_factory(self) -> None:
        factory_name = CONDITION_FACTORIES["single_agent"](n=5).name
        assert canonical_condition_name("single_agent", 5) == factory_name


# --- grader_factory_for ---


class TestGraderFactoryFor:
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
    def test_returns_callable_for_all_targets(self, key: str) -> None:
        factory = grader_factory_for(key)
        assert callable(factory)

    def test_prose_accepts_judge_llm_none(self) -> None:
        factory = grader_factory_for("prose_substrate_thesis", judge_llm=None)
        assert callable(factory)

    def test_unknown_target_raises(self) -> None:
        with pytest.raises(ValueError):
            grader_factory_for("not_a_real_target")
