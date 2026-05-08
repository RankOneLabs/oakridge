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


# --- new-factory smoke tests --------------------------------------------
#
# The shared _LeetcodeMechanicalGrader is exercised end-to-end above
# against the longest-substring target. The two newer factories
# (trapping rain water, regex matching) reuse the same grader class
# but ship their own test-file strings — these smoke tests catch
# import-name drift between target/test-file/grader-factory and
# verify a known-correct reference solution scores 1.0 on tests +
# mypy. They're not exhaustive correctness tests; they're a
# wired-up-correctly check.


_TRAPPING_RAIN_WATER_REFERENCE_SOLUTION = (
    "def trap(height: list[int]) -> int:\n"
    "    if len(height) < 3:\n"
    "        return 0\n"
    "    left, right = 0, len(height) - 1\n"
    "    left_max, right_max = 0, 0\n"
    "    total = 0\n"
    "    while left < right:\n"
    "        if height[left] < height[right]:\n"
    "            if height[left] >= left_max:\n"
    "                left_max = height[left]\n"
    "            else:\n"
    "                total += left_max - height[left]\n"
    "            left += 1\n"
    "        else:\n"
    "            if height[right] >= right_max:\n"
    "                right_max = height[right]\n"
    "            else:\n"
    "                total += right_max - height[right]\n"
    "            right -= 1\n"
    "    return total\n"
)


@_NEEDS_TOOLCHAIN
async def test_trapping_rain_water_factory_reference_solution_passes() -> None:
    """Two-pointer reference scores 1.0 on tests + mypy. Catches
    drift in the test-file's solution-import name or signature."""
    target = code_leetcode_trapping_rain_water()
    factory = make_leetcode_trapping_rain_water_grader_factory()
    grader = factory(target)
    scores = await grader.grade(
        input=target.brief.target_spec,
        output=_TRAPPING_RAIN_WATER_REFERENCE_SOLUTION,
    )
    by_dim = {s.dimension: s.value for s in scores}
    assert by_dim["tests"] == 1.0
    assert by_dim["mypy"] == 1.0


_REGEX_MATCHING_REFERENCE_SOLUTION = (
    "from functools import lru_cache\n"
    "\n"
    "\n"
    "def is_match(s: str, p: str) -> bool:\n"
    "    @lru_cache(maxsize=None)\n"
    "    def helper(i: int, j: int) -> bool:\n"
    "        if j == len(p):\n"
    "            return i == len(s)\n"
    "        first = i < len(s) and (p[j] == s[i] or p[j] == '.')\n"
    "        if j + 1 < len(p) and p[j + 1] == '*':\n"
    "            return helper(i, j + 2) or (\n"
    "                first and helper(i + 1, j)\n"
    "            )\n"
    "        return first and helper(i + 1, j + 1)\n"
    "    return helper(0, 0)\n"
)


@_NEEDS_TOOLCHAIN
async def test_regex_matching_factory_reference_solution_passes() -> None:
    """Recursive memoized reference scores 1.0 on tests + mypy.
    Catches drift in the test-file's solution-import name or
    signature."""
    target = code_leetcode_regex_matching()
    factory = make_leetcode_regex_matching_grader_factory()
    grader = factory(target)
    scores = await grader.grade(
        input=target.brief.target_spec,
        output=_REGEX_MATCHING_REFERENCE_SOLUTION,
    )
    by_dim = {s.dimension: s.value for s in scores}
    assert by_dim["tests"] == 1.0
    assert by_dim["mypy"] == 1.0


# Reference O(log(min(m, n))) partition algorithm (the canonical
# LeetCode editorial Approach 4). Sentinels typed as int — using
# ``float('-inf')`` would force a float|int union that mypy strict
# rejects without explicit annotations.
_MEDIAN_TWO_SORTED_ARRAYS_REFERENCE_SOLUTION = (
    "def find_median_sorted_arrays(\n"
    "    nums1: list[int], nums2: list[int]\n"
    ") -> float:\n"
    "    if len(nums1) > len(nums2):\n"
    "        nums1, nums2 = nums2, nums1\n"
    "    m, n = len(nums1), len(nums2)\n"
    "    total = m + n\n"
    "    half = (total + 1) // 2\n"
    "    neg_inf = -(10 ** 18)\n"
    "    pos_inf = 10 ** 18\n"
    "    lo, hi = 0, m\n"
    "    while lo <= hi:\n"
    "        i = (lo + hi) // 2\n"
    "        j = half - i\n"
    "        a_left = nums1[i - 1] if i > 0 else neg_inf\n"
    "        a_right = nums1[i] if i < m else pos_inf\n"
    "        b_left = nums2[j - 1] if j > 0 else neg_inf\n"
    "        b_right = nums2[j] if j < n else pos_inf\n"
    "        if a_left <= b_right and b_left <= a_right:\n"
    "            if total % 2 == 1:\n"
    "                return float(max(a_left, b_left))\n"
    "            return (max(a_left, b_left) + min(a_right, b_right)) / 2.0\n"
    "        if a_left > b_right:\n"
    "            hi = i - 1\n"
    "        else:\n"
    "            lo = i + 1\n"
    "    raise ValueError('inputs were not sorted')\n"
)


@_NEEDS_TOOLCHAIN
async def test_median_two_sorted_arrays_factory_reference_solution_passes() -> None:
    """Reference partition algorithm scores 1.0 on tests + mypy + perf.
    Catches drift in test-file import names and verifies the perf
    dimension actually runs (no signal-handler import issues, no
    SIGALRM permission problems on this runner)."""
    target = code_leetcode_median_two_sorted_arrays()
    factory = make_leetcode_median_two_sorted_arrays_grader_factory()
    grader = factory(target)
    scores = await grader.grade(
        input=target.brief.target_spec,
        output=_MEDIAN_TWO_SORTED_ARRAYS_REFERENCE_SOLUTION,
    )
    by_dim = {s.dimension: s.value for s in scores}
    assert by_dim["tests"] == 1.0
    assert by_dim["mypy"] == 1.0
    assert by_dim["perf"] == 1.0


# A correct-but-slow O(m+n) merge solution. Should pass tests + mypy
# (correctness is fine, types are clean) but FAIL the perf dimension
# on the 2×3M input — pure-Python merge takes ~270ms, well past the
# 100ms budget. This is the honest discrimination signal the median
# target was added to produce — no fake pessimization, just the kind
# of merge a model writes when it doesn't know the partition trick.
_MEDIAN_TWO_SORTED_ARRAYS_SLOW_SOLUTION = (
    "def find_median_sorted_arrays(\n"
    "    nums1: list[int], nums2: list[int]\n"
    ") -> float:\n"
    "    merged: list[int] = []\n"
    "    i = j = 0\n"
    "    while i < len(nums1) and j < len(nums2):\n"
    "        if nums1[i] <= nums2[j]:\n"
    "            merged.append(nums1[i])\n"
    "            i += 1\n"
    "        else:\n"
    "            merged.append(nums2[j])\n"
    "            j += 1\n"
    "    merged.extend(nums1[i:])\n"
    "    merged.extend(nums2[j:])\n"
    "    n = len(merged)\n"
    "    if n % 2 == 1:\n"
    "        return float(merged[n // 2])\n"
    "    return (merged[n // 2 - 1] + merged[n // 2]) / 2.0\n"
)


@_NEEDS_TOOLCHAIN
async def test_median_two_sorted_arrays_slow_solution_fails_perf_only() -> None:
    """Slow (but correct) O(m+n) solution: passes tests + mypy, fails
    perf. Verifies the perf dimension actually discriminates rather
    than just rubber-stamping anything that compiles."""
    target = code_leetcode_median_two_sorted_arrays()
    factory = make_leetcode_median_two_sorted_arrays_grader_factory()
    grader = factory(target)
    scores = await grader.grade(
        input=target.brief.target_spec,
        output=_MEDIAN_TWO_SORTED_ARRAYS_SLOW_SOLUTION,
    )
    by_dim = {s.dimension: s.value for s in scores}
    assert by_dim["tests"] == 1.0
    assert by_dim["mypy"] == 1.0
    assert by_dim["perf"] < 1.0


# Sort-then-pick: correct + would slip under the wall-clock budget
# (timsort is C-optimized) but fails the AST guard the perf test
# runs first. Without the guard this would silently score 1.0 on
# perf despite violating the brief's complexity requirement.
_MEDIAN_TWO_SORTED_ARRAYS_SORT_SOLUTION = (
    "def find_median_sorted_arrays(\n"
    "    nums1: list[int], nums2: list[int]\n"
    ") -> float:\n"
    "    merged = sorted(nums1 + nums2)\n"
    "    n = len(merged)\n"
    "    if n % 2 == 1:\n"
    "        return float(merged[n // 2])\n"
    "    return (merged[n // 2 - 1] + merged[n // 2]) / 2.0\n"
)


@_NEEDS_TOOLCHAIN
async def test_median_two_sorted_arrays_sort_solution_fails_perf_via_ast_guard() -> None:
    """Sort-then-pick: correct on tests + clean on mypy, but the
    perf test's AST guard rejects ``sorted(...)`` before timing —
    so perf still scores < 1.0. Closes the loophole CPython's
    timsort would otherwise open (sorted at this scale finishes in
    ~50ms, well under the 100ms wall-clock budget)."""
    target = code_leetcode_median_two_sorted_arrays()
    factory = make_leetcode_median_two_sorted_arrays_grader_factory()
    grader = factory(target)
    scores = await grader.grade(
        input=target.brief.target_spec,
        output=_MEDIAN_TWO_SORTED_ARRAYS_SORT_SOLUTION,
    )
    by_dim = {s.dimension: s.value for s in scores}
    assert by_dim["tests"] == 1.0
    assert by_dim["mypy"] == 1.0
    assert by_dim["perf"] < 1.0
