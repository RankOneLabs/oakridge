"""Canonical study-registry: shared source of truth for task/condition/grader mappings.

Exports:

- :data:`TASK_FACTORIES` — task key -> zero-arg factory returning :class:`TaskConfig`
- :data:`TASK_CATALOG` — immutable task summaries for dashboard / run-resolution consumers
- :data:`GRADER_CATALOG` — immutable grader metadata for safe grader selection
- :data:`CONDITION_FACTORIES` — condition kind -> keyword-only-``n`` factory
  returning :class:`ConditionConfig`
- :func:`grader_factory_for` — resolve a :class:`GraderFactory` by target key
- :func:`task_summary_for` — resolve a registered task summary by name
- :func:`grader_metadata_for` — resolve a registered grader metadata entry by key
- :func:`canonical_condition_name` — produce the on-disk condition directory segment

These were previously duplicated across ``scripts/run_v1_study.py`` (lines 86-105
and 481-508). This module is the single source of truth; ``run_v1_study.py`` and
cohort 2's ``run.py`` import from here.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from jig.core.types import LLMClient

from legit_biz_club.core.models import ArtifactType
from legit_biz_club.study.conditions import (
    ConditionConfig,
    ensemble_incremental_only,
    ensemble_with_multi_round,
    ensemble_with_single_round,
    single_agent_baseline,
)
from legit_biz_club.study.runner import GraderFactory
from legit_biz_club.study.targets import TaskConfig
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

TaskSource = Literal["builtin"]


@dataclass(frozen=True, slots=True)
class TaskSummary:
    """Immutable summary of one registered task."""

    name: str
    artifact_type: ArtifactType
    artifact_filename: str
    has_grader: bool
    grader_key: str | None = None
    source: TaskSource = "builtin"


@dataclass(frozen=True, slots=True)
class GraderMetadata:
    """Immutable summary of one registered grader."""

    key: str
    label: str
    supported_artifact_types: tuple[ArtifactType, ...]
    capabilities: tuple[str, ...]
    config_schema: dict[str, object] | None = None


TASK_FACTORIES: dict[str, Callable[[], TaskConfig]] = {
    "prose_substrate_thesis": prose_substrate_thesis,
    "code_leetcode_longest_substring": code_leetcode_longest_substring,
    "code_leetcode_trapping_rain_water": code_leetcode_trapping_rain_water,
    "code_leetcode_regex_matching": code_leetcode_regex_matching,
    "code_leetcode_median_two_sorted_arrays": (
        code_leetcode_median_two_sorted_arrays
    ),
}

TARGET_FACTORIES = TASK_FACTORIES

_TASK_GRADER_KEYS: dict[str, str] = {
    key: key for key in TASK_FACTORIES
}

def _make_task_summary(
    task_key: str, factory: Callable[[], TaskConfig]
) -> TaskSummary:
    task = factory()
    return TaskSummary(
        name=task_key,
        artifact_type=task.artifact_type,
        artifact_filename=task.artifact_filename,
        has_grader=task_key in _TASK_GRADER_KEYS,
        grader_key=_TASK_GRADER_KEYS.get(task_key),
    )


TASK_CATALOG: tuple[TaskSummary, ...] = tuple(
    _make_task_summary(task_key, factory)
    for task_key, factory in TASK_FACTORIES.items()
)

TASK_CATALOG_BY_NAME: dict[str, TaskSummary] = {
    entry.name: entry for entry in TASK_CATALOG
}

GRADER_CATALOG: tuple[GraderMetadata, ...] = (
    GraderMetadata(
        key="prose_substrate_thesis",
        label="Brief judge",
        supported_artifact_types=(ArtifactType.PROSE,),
        capabilities=("brief-criteria", "llm-judge"),
    ),
    GraderMetadata(
        key="code_leetcode_longest_substring",
        label="LeetCode #3 mechanical grader",
        supported_artifact_types=(ArtifactType.CODE,),
        capabilities=("pytest", "mypy"),
    ),
    GraderMetadata(
        key="code_leetcode_trapping_rain_water",
        label="LeetCode #42 mechanical grader",
        supported_artifact_types=(ArtifactType.CODE,),
        capabilities=("pytest", "mypy"),
    ),
    GraderMetadata(
        key="code_leetcode_regex_matching",
        label="LeetCode #10 mechanical grader",
        supported_artifact_types=(ArtifactType.CODE,),
        capabilities=("pytest", "mypy"),
    ),
    GraderMetadata(
        key="code_leetcode_median_two_sorted_arrays",
        label="LeetCode #4 mechanical grader",
        supported_artifact_types=(ArtifactType.CODE,),
        capabilities=("pytest", "mypy", "perf"),
    ),
)

GRADER_CATALOG_BY_KEY: dict[str, GraderMetadata] = {
    entry.key: entry for entry in GRADER_CATALOG
}

_GRADER_FACTORY_BUILDERS: dict[
    str, Callable[[LLMClient | None], GraderFactory]
] = {
    "prose_substrate_thesis": (
        lambda judge_llm: make_prose_substrate_thesis_grader_factory(
            judge_llm=judge_llm
        )
    ),
    "code_leetcode_longest_substring": (
        lambda _judge_llm: make_leetcode_longest_substring_grader_factory()
    ),
    "code_leetcode_trapping_rain_water": (
        lambda _judge_llm: make_leetcode_trapping_rain_water_grader_factory()
    ),
    "code_leetcode_regex_matching": (
        lambda _judge_llm: make_leetcode_regex_matching_grader_factory()
    ),
    "code_leetcode_median_two_sorted_arrays": (
        lambda _judge_llm: make_leetcode_median_two_sorted_arrays_grader_factory()
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


def task_summary_for(task_key: str) -> TaskSummary:
    """Return the registered summary for one task key."""
    try:
        return TASK_CATALOG_BY_NAME[task_key]
    except KeyError as exc:
        raise ValueError(f"no task summary for {task_key!r}") from exc


def grader_metadata_for(grader_key: str) -> GraderMetadata:
    """Return the registered metadata for one grader key."""
    try:
        return GRADER_CATALOG_BY_KEY[grader_key]
    except KeyError as exc:
        raise ValueError(f"no grader metadata for {grader_key!r}") from exc


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
    try:
        builder = _GRADER_FACTORY_BUILDERS[target_key]
    except KeyError as exc:
        raise ValueError(f"no grader factory for target {target_key!r}") from exc
    return builder(judge_llm)


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
