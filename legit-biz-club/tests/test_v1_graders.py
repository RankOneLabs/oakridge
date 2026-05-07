"""Tests for the v1 study grader factories.

The leetcode grader runs real subprocesses (pytest / mypy)
against materialized files, so these tests run those tools too —
slower than pure-Python tests but deterministic. Skipped if the
binaries aren't on PATH.

The prose grader's tests stub out the judge LLM rather than making
real API calls; the grader factory's job is just to wire
make_brief_judge correctly.
"""
from __future__ import annotations

import shutil

import pytest
from jig.core.types import (
    CompletionParams,
    LLMClient,
    LLMResponse,
    Score,
    Usage,
)

from legit_biz_club.study.v1_graders import (
    _LEETCODE_TEST_FILE,
    make_leetcode_longest_substring_grader_factory,
    make_prose_substrate_thesis_grader_factory,
)
from legit_biz_club.study.v1_targets import (
    code_leetcode_longest_substring,
    prose_substrate_thesis,
)

# --- prose grader --------------------------------------------------------


class _StubLLM(LLMClient):
    """Returns a canned LLMJudge-shaped JSON response."""

    def __init__(self, content: str) -> None:
        self._content = content

    async def complete(self, params: CompletionParams) -> LLMResponse:
        return LLMResponse(
            content=self._content,
            tool_calls=None,
            usage=Usage(input_tokens=10, output_tokens=20),
            latency_ms=42.0,
            model="stub",
        )


async def test_prose_grader_factory_wraps_make_brief_judge() -> None:
    """The factory takes a TargetConfig and returns a Grader. With a
    stub LLM that returns a well-formed JSON judgment, grade()
    produces one Score per success-criterion in the brief."""
    target = prose_substrate_thesis()
    n_dimensions = len(target.brief.success_criteria)
    # Build a JSON shaped like LLMJudge expects: a list of
    # {dimension, value} entries. Anything else gets fallback-scored
    # to 0.0 by jig's parser.
    scores_obj = {
        "scores": [
            {"dimension": dim, "value": 0.7}
            for dim in target.brief.success_criteria
        ],
    }
    import json

    stub = _StubLLM(json.dumps(scores_obj))

    factory = make_prose_substrate_thesis_grader_factory(judge_llm=stub)
    grader = factory(target)
    result = await grader.grade(
        input=target.brief.target_spec, output="some artifact content"
    )
    assert len(result) == n_dimensions
    assert all(isinstance(s, Score) for s in result)
    assert all(s.value == 0.7 for s in result)


async def test_prose_grader_factory_default_llm_lazy_constructed() -> None:
    """Calling the factory builder with no judge_llm shouldn't try
    to reach an LLM provider — it should defer construction until
    needed (or fail with a clear error if the provider env isn't
    set). A factory built without ANTHROPIC_API_KEY should still
    succeed at construction time."""
    # Just exercise the no-arg path. If the default model can't be
    # built without env vars, this would fail at import time.
    factory = make_prose_substrate_thesis_grader_factory()
    assert callable(factory)


# --- leetcode grader -----------------------------------------------------


def _binaries_on_path() -> bool:
    return all(shutil.which(b) for b in ("pytest", "mypy"))


_NEEDS_TOOLCHAIN = pytest.mark.skipif(
    not _binaries_on_path(),
    reason="leetcode grader needs pytest/mypy on PATH",
)


_CORRECT_SOLUTION = (
    "def length_of_longest_substring(s: str) -> int:\n"
    "    seen: dict[str, int] = {}\n"
    "    start = 0\n"
    "    best = 0\n"
    "    for i, ch in enumerate(s):\n"
    "        if ch in seen and seen[ch] >= start:\n"
    "            start = seen[ch] + 1\n"
    "        seen[ch] = i\n"
    "        best = max(best, i - start + 1)\n"
    "    return best\n"
)


_BROKEN_SOLUTION = (
    "def length_of_longest_substring(s: str) -> int:\n"
    "    return 0  # always wrong except for empty string\n"
)


@_NEEDS_TOOLCHAIN
async def test_leetcode_grader_correct_solution_passes_all_checks() -> None:
    """A correct sliding-window solution should score 1.0 on tests
    and mypy. Lint was removed from the leetcode pipeline (see module
    docstring on v1_graders)."""
    target = code_leetcode_longest_substring()
    factory = make_leetcode_longest_substring_grader_factory()
    grader = factory(target)
    scores = await grader.grade(
        input=target.brief.target_spec, output=_CORRECT_SOLUTION
    )
    by_dim = {s.dimension: s.value for s in scores}
    assert by_dim["tests"] == 1.0
    assert by_dim["mypy"] == 1.0
    assert "ruff" not in by_dim


@_NEEDS_TOOLCHAIN
async def test_leetcode_grader_broken_solution_fails_tests() -> None:
    """A trivially-wrong solution (always returns 0) passes mypy but
    fails most tests. The grader should reflect that — tests
    dimension scores below 1.0, mypy stays at 1.0."""
    target = code_leetcode_longest_substring()
    factory = make_leetcode_longest_substring_grader_factory()
    grader = factory(target)
    scores = await grader.grade(
        input=target.brief.target_spec, output=_BROKEN_SOLUTION
    )
    by_dim = {s.dimension: s.value for s in scores}
    # Only the empty-string case passes; 1/8 = 0.125.
    assert by_dim["tests"] < 0.5
    assert by_dim["mypy"] == 1.0


_UNTYPED_SOLUTION = (
    "def length_of_longest_substring(s):\n"  # missing annotations
    "    return 0\n"
)


@_NEEDS_TOOLCHAIN
async def test_leetcode_grader_enforces_strict_mypy_via_project_config() -> None:
    """Without the pyproject.toml stub, mypy runs in non-strict mode
    and untyped function definitions pass silently — the brief's
    'type-checks under strict mypy' criterion would silently grade
    every untyped artifact as 1.0. The stub pins strict=true; this
    test verifies the stub is being read."""
    target = code_leetcode_longest_substring()
    factory = make_leetcode_longest_substring_grader_factory()
    grader = factory(target)
    scores = await grader.grade(
        input=target.brief.target_spec,
        output=_UNTYPED_SOLUTION,
    )
    by_dim = {s.dimension: s.value for s in scores}
    assert by_dim["mypy"] < 1.0


def test_leetcode_test_file_constant_imports_solution() -> None:
    """The materialized test file must import from `solution` (the
    artifact filename's module name) — pytest discovers test_*.py
    files in the tmpdir and the import has to resolve. A drift in
    artifact filename would break this silently otherwise."""
    assert "from solution import length_of_longest_substring" in _LEETCODE_TEST_FILE
