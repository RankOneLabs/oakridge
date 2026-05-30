"""Canonical study-registry: shared source of truth for target/condition/grader mappings.

Exports:

- :data:`TARGET_FACTORIES` — target key -> zero-arg factory returning :class:`TargetConfig`
- :data:`CONDITION_FACTORIES` — condition kind -> keyword-only-``n`` factory
  returning :class:`ConditionConfig`
- :func:`grader_factory_for` — resolve a :class:`GraderFactory` by target key
- :func:`canonical_condition_name` — produce the on-disk condition directory segment

These were previously duplicated across ``scripts/run_v1_study.py`` (lines 86-105
and 481-508). This module is the single source of truth; ``run_v1_study.py`` and
cohort 2's ``run.py`` import from here.
"""
from __future__ import annotations

from collections.abc import Callable

from jig.core.types import LLMClient

from legit_biz_club.study.conditions import (
    ConditionConfig,
    ensemble_incremental_only,
    ensemble_with_multi_round,
    ensemble_with_single_round,
    single_agent_baseline,
)
from legit_biz_club.study.runner import GraderFactory
from legit_biz_club.study.targets import TargetConfig
from legit_biz_club.study.v1_graders import (
    make_leetcode_longest_substring_grader_factory,
    make_leetcode_median_two_sorted_arrays_grader_factory,
    make_leetcode_regex_matching_grader_factory,
    make_leetcode_trapping_rain_water_grader_factory,
    make_prose_substrate_thesis_grader_factory,
)
from legit_biz_club.study.v1_targets import (
    code_leetcode_longest_substring,
    code_leetcode_median_two_sorted_arrays,
    code_leetcode_regex_matching,
    code_leetcode_trapping_rain_water,
    prose_substrate_thesis,
)

TARGET_FACTORIES: dict[str, Callable[[], TargetConfig]] = {
    "prose_substrate_thesis": prose_substrate_thesis,
    "code_leetcode_longest_substring": code_leetcode_longest_substring,
    "code_leetcode_trapping_rain_water": code_leetcode_trapping_rain_water,
    "code_leetcode_regex_matching": code_leetcode_regex_matching,
    "code_leetcode_median_two_sorted_arrays": (
        code_leetcode_median_two_sorted_arrays
    ),
}

# Condition kind -> keyword-only ``n`` factory. single_agent ignores n;
# the ensemble kinds pass it through. Mirrors run_v1_study.py lines 100-105.
CONDITION_FACTORIES: dict[str, Callable[..., ConditionConfig]] = {
    "single_agent": lambda *, n: single_agent_baseline(),
    "ensemble_incremental": lambda *, n: ensemble_incremental_only(n=n),
    "ensemble_single_round": lambda *, n: ensemble_with_single_round(n=n),
    "ensemble_multi_round": lambda *, n: ensemble_with_multi_round(n=n),
}


def grader_factory_for(
    target_key: str,
    *,
    judge_llm: LLMClient | None = None,
) -> GraderFactory:
    """Return a :class:`GraderFactory` for the given target key.

    ``judge_llm`` is forwarded to the prose grader factory and ignored
    for all leetcode targets (which are fully mechanical). Pass ``None``
    (the default) to let the prose factory fall back to its own default
    (``claude-sonnet-4-5``).

    Raises :class:`ValueError` for unknown ``target_key``.
    """
    if target_key == "prose_substrate_thesis":
        return make_prose_substrate_thesis_grader_factory(
            judge_llm=judge_llm
        )
    if target_key == "code_leetcode_longest_substring":
        return make_leetcode_longest_substring_grader_factory()
    if target_key == "code_leetcode_trapping_rain_water":
        return make_leetcode_trapping_rain_water_grader_factory()
    if target_key == "code_leetcode_regex_matching":
        return make_leetcode_regex_matching_grader_factory()
    if target_key == "code_leetcode_median_two_sorted_arrays":
        return make_leetcode_median_two_sorted_arrays_grader_factory()
    raise ValueError(f"no grader factory for target {target_key!r}")


def canonical_condition_name(kind: str, n: int) -> str:
    """Return the on-disk condition directory segment for a given kind and n.

    Mirrors the ``name`` field produced by the condition factories in
    :mod:`legit_biz_club.study.conditions`:

    - ``single_agent``          -> ``'single_agent'``          (n ignored)
    - ``ensemble_incremental``  -> ``f'ensemble_incremental_n{n}'``
    - ``ensemble_single_round`` -> ``f'ensemble_single_round_n{n}'``
    - ``ensemble_multi_round``  -> ``f'ensemble_multi_round_n{n}'``

    This string is the parity contract cohort 3 reproduces in TypeScript.
    Raises :class:`ValueError` for unknown ``kind``.
    """
    if kind == "single_agent":
        return "single_agent"
    if kind == "ensemble_incremental":
        return f"ensemble_incremental_n{n}"
    if kind == "ensemble_single_round":
        return f"ensemble_single_round_n{n}"
    if kind == "ensemble_multi_round":
        return f"ensemble_multi_round_n{n}"
    raise ValueError(f"unknown condition kind {kind!r}")
