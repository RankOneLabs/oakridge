"""Concrete v1 study graders — eval factories matched to the v1 targets.

Per the design memo, v1 ships two eval primitives (prose + code) and
the study runs them via ``GraderFactory`` callables passed to
``run_cell``. This module pairs each :func:`v1_targets` factory with
a corresponding grader factory:

- :func:`make_prose_substrate_thesis_grader_factory` — wraps jig's
  :class:`LLMJudge` via the existing :func:`make_brief_judge`. Takes
  a judge LLM with a sensible default; operator overrides for
  production studies (the judge should be distinct from the writer
  pool).
- :func:`make_leetcode_longest_substring_grader_factory`,
  :func:`make_leetcode_trapping_rain_water_grader_factory`, and
  :func:`make_leetcode_regex_matching_grader_factory` — all three
  wrap a generic mechanical grader that materializes the artifact +
  a per-target test file + a stub pyproject.toml into a tmpdir,
  then runs pytest + mypy. The factories share the grader; only
  the test file string differs.

  Lint (ruff) was removed from the leetcode pipeline: the brief told
  agents "passes ruff lint with project defaults" but the grader
  enforced a stricter selection (E,F,W,I,UP,B,SIM) than ruff's true
  defaults (E,F). Agents were graded on a config they couldn't see,
  which produced uniform 0.0 scores that were noise on the
  condition-effect signal rather than real discrimination. If
  lint-quality discrimination is wanted later, ship a target whose
  brief is explicitly "produce idiomatic, lint-clean Python" with
  the rule selection in the brief.

Both fit the ``GraderFactory = Callable[[TargetConfig], Grader]``
signature and slot into ``run_cell``'s ``grader_factory=`` parameter.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from jig.core.types import Grader, LLMClient, Score
from jig.feedback.heuristic import HeuristicGrader
from jig.llm.factory import from_model

from legit_biz_club.eval.code import (
    mypy_check,
    pytest_check,
)
from legit_biz_club.eval.prose import make_brief_judge
from legit_biz_club.study.runner import GraderFactory
from legit_biz_club.study.targets import TargetConfig

# --- prose grader --------------------------------------------------------


# Default judge model: strong reasoner, distinct from claude-opus-4-7
# (the most expensive Anthropic model) and cheaper than it. It IS in
# the default writer pool though — for **production** study runs the
# operator should override to a model that's NOT in their writer pool
# so judgments aren't biased by self-evaluation.
_DEFAULT_JUDGE_MODEL = "claude-sonnet-4-5"


def make_prose_substrate_thesis_grader_factory(
    judge_llm: LLMClient | None = None,
) -> GraderFactory:
    """Build a grader factory for :func:`prose_substrate_thesis`.

    Wraps :func:`make_brief_judge` so each entry in the brief's
    ``success_criteria`` becomes a judge dimension. The judge sees
    the brief's ``target_spec`` and ``constraints`` as rubric context.

    ``judge_llm`` defaults to ``from_model("claude-sonnet-4-5")`` —
    cheap, strong reasoner, distinct from Opus. The default is
    constructed lazily inside the inner factory rather than at
    builder-call time, so importing this module (or building the
    factory) doesn't reach an LLM provider until ``run_cell``
    actually invokes the factory. Override for production studies:
    the judge should ideally be in a different provider from the
    writer pool so identity-driven self-bias is impossible. The
    smoke pool is Anthropic-only by default; pinning the judge to
    OpenAI or Google needs that provider's API key.
    """

    def factory(target: TargetConfig) -> Grader:
        # Resolve the LLM here rather than at builder-call time so
        # the env-var dependency surfaces at run_cell construction
        # (when the operator clearly intended to use it) rather than
        # at module import.
        llm = (
            judge_llm
            if judge_llm is not None
            else from_model(_DEFAULT_JUDGE_MODEL)
        )
        return make_brief_judge(target.brief, judge_llm=llm)

    return factory


# --- code grader ---------------------------------------------------------


# Stub pyproject.toml materialized in the grader's tmpdir so mypy
# runs in strict mode, not its lenient defaults. Without this, mypy
# accepts untyped function defs and the brief's "type-checks under
# strict mypy" criterion would silently grade as a pass-through.
# Mirrors legit-biz-club's mypy config; keep in sync if the
# project's typecheck strictness drifts. Ruff is intentionally
# omitted (see module docstring).
_PROJECT_PYPROJECT_STUB = """\
[tool.mypy]
python_version = "3.12"
strict = true
warn_return_any = true
warn_unused_configs = true
disallow_untyped_defs = true
"""


# pytest test file materialized alongside the artifact in a tmpdir
# per grade(). Module-level string constant so the test cases live
# in one place; updates to the brief's example block should keep
# this in sync.
_LEETCODE_TEST_FILE = '''\
"""Tests for the leetcode #3 artifact (longest substring without repeating chars).

Materialized into the grader's tmpdir alongside the agent-produced
solution.py. Pytest auto-discovers test_*.py files and imports
solution from the same directory.
"""
from solution import length_of_longest_substring


def test_abcabcbb() -> None:
    assert length_of_longest_substring("abcabcbb") == 3


def test_bbbbb() -> None:
    assert length_of_longest_substring("bbbbb") == 1


def test_pwwkew() -> None:
    assert length_of_longest_substring("pwwkew") == 3


def test_empty() -> None:
    assert length_of_longest_substring("") == 0


def test_au() -> None:
    assert length_of_longest_substring("au") == 2


def test_single_space() -> None:
    assert length_of_longest_substring(" ") == 1


def test_dvdf() -> None:
    assert length_of_longest_substring("dvdf") == 3


def test_case_sensitive_aa() -> None:
    """Brief explicitly requires case-sensitive: 'Aa' has 2 distinct
    characters, so the longest non-repeating substring is the whole
    string."""
    assert length_of_longest_substring("Aa") == 2
'''


class _LeetcodeMechanicalGrader:
    """Grader that materializes the artifact + a per-target test file
    into a tmpdir, then runs pytest / mypy against it via jig's
    :class:`HeuristicGrader`.

    Test-file content is injected at construction so the same grader
    class serves any leetcode-shaped target (longest-substring,
    trapping-rain-water, future Hard problems). Adding a new code
    target now means defining a test file string + wiring a new
    factory — no new grader class.

    Optional ``perf_test_content``: when set, materializes a second
    ``test_perf.py`` alongside ``test_solution.py`` and runs it as a
    separate ``perf`` dimension. Perf tests use signal-based timeouts
    inside the test body (see the median target's perf file for the
    pattern) so a slow algorithm fails the perf dimension without
    crashing the run. Targets without a meaningful complexity bound
    (e.g., regex matching) leave it ``None``.

    The tmpdir lives only for the duration of the ``grade()`` call —
    we don't keep the artifact lying around because the cell's
    ``solution.py`` (under ``.run/<ts>/...``) is the durable copy. The
    tmpdir is purely for the subprocess checks that need a real
    file on disk.
    """

    def __init__(
        self,
        *,
        test_file_content: str,
        perf_test_content: str | None = None,
        perf_timeout_s: float = 30.0,
    ) -> None:
        self._test_file = test_file_content
        self._perf_test = perf_test_content
        self._perf_timeout_s = perf_timeout_s

    async def grade(
        self,
        input: str,  # noqa: A002 — Grader protocol
        output: str,
        context: dict[str, object] | None = None,
    ) -> list[Score]:
        with tempfile.TemporaryDirectory(prefix="lbc-leetcode-grade-") as d:
            dpath = Path(d)
            (dpath / "pyproject.toml").write_text(
                _PROJECT_PYPROJECT_STUB, encoding="utf-8"
            )
            (dpath / "solution.py").write_text(output, encoding="utf-8")
            test_solution_path = dpath / "test_solution.py"
            test_solution_path.write_text(
                self._test_file, encoding="utf-8"
            )
            checks = [
                # Scope the correctness pytest run to test_solution.py
                # explicitly so perf tests (when present) don't leak
                # into the tests dimension via auto-discovery.
                pytest_check(
                    dpath,
                    name="tests",
                    cwd=dpath,
                    test_paths=[test_solution_path],
                ),
                mypy_check(dpath, name="mypy", cwd=dpath),
            ]
            if self._perf_test is not None:
                test_perf_path = dpath / "test_perf.py"
                test_perf_path.write_text(
                    self._perf_test, encoding="utf-8"
                )
                checks.append(
                    pytest_check(
                        dpath,
                        name="perf",
                        cwd=dpath,
                        test_paths=[test_perf_path],
                        timeout_s=self._perf_timeout_s,
                    )
                )
            heuristic = HeuristicGrader(checks=checks)
            scores: list[Score] = await heuristic.grade(
                input, output, context
            )
            return scores


def make_leetcode_longest_substring_grader_factory() -> GraderFactory:
    """Build a grader factory for :func:`code_leetcode_longest_substring`.

    Returns a grader that, on each ``grade()`` call, writes the
    artifact + the fixed leetcode-#3 test file + a stub
    ``pyproject.toml`` for mypy strictness into a fresh tmpdir, then
    runs:

    - pytest against the 8 canonical leetcode #3 cases
    - mypy on solution.py — strictness comes from the stub
      pyproject.toml (``strict=true``), NOT mypy's defaults

    Each check returns a 0..1 score. ``HeuristicGrader`` aggregates
    them into one :class:`Score` per check name. No LLM calls — fully
    mechanical — so this grader is cheap and deterministic compared
    to the prose judge.

    Trust posture: the grader runs LLM-generated code via subprocess
    with the parent process's environment inherited (so e.g. API
    keys leak through). v1's operator runs the harness on their own
    machine against agents using their own API keys; the agents are
    operator-trusted by design. If the harness is ever run in a
    less-trusted operator context, the subprocess invocations should
    move to a sandboxed env (scrubbed env vars, isolated venv,
    network disabled) — which probably belongs in jig's
    :mod:`jig.feedback.heuristic` ``Check`` machinery, not here.
    """

    def factory(target: TargetConfig) -> Grader:
        # Wiring guard: each factory ships its own test-file string,
        # so routing the wrong target through this factory would
        # silently grade against the longest-substring tests. Fail
        # loud at factory call time rather than burying the mismatch
        # in test failures the operator has to diff manually.
        if target.name != "code_leetcode_longest_substring":
            raise ValueError(
                f"longest-substring grader factory called with "
                f"target {target.name!r}"
            )
        return _LeetcodeMechanicalGrader(
            test_file_content=_LEETCODE_TEST_FILE
        )

    return factory


# --- code grader: leetcode #42 (trapping rain water) -------------------


_TRAPPING_RAIN_WATER_TEST_FILE = '''\
"""Tests for the leetcode #42 artifact (trapping rain water).

Materialized into the grader's tmpdir alongside the agent-produced
solution.py. Pytest auto-discovers test_*.py files and imports trap
from the same directory.
"""
from solution import trap


def test_canonical_a() -> None:
    assert trap([0, 1, 0, 2, 1, 0, 1, 3, 2, 1, 2, 1]) == 6


def test_canonical_b() -> None:
    assert trap([4, 2, 0, 3, 2, 5]) == 9


def test_multiple_basins() -> None:
    assert trap([3, 0, 2, 0, 4]) == 7


def test_empty() -> None:
    assert trap([]) == 0


def test_single() -> None:
    assert trap([5]) == 0


def test_two_elements() -> None:
    """Two bars trap nothing — no enclosing wall on the right."""
    assert trap([2, 3]) == 0


def test_flat() -> None:
    assert trap([3, 3, 3]) == 0


def test_simple_basin() -> None:
    """One valley between two equal walls."""
    assert trap([5, 0, 5]) == 5


def test_monotonic_increasing() -> None:
    assert trap([1, 2, 3, 4, 5]) == 0


def test_monotonic_decreasing() -> None:
    assert trap([5, 4, 3, 2, 1]) == 0


def test_pyramid() -> None:
    """Single peak — no enclosing wall on either descent."""
    assert trap([1, 2, 3, 4, 3, 2, 1]) == 0
'''


# --- code grader: leetcode #10 (regular expression matching) -----------


_REGEX_MATCHING_TEST_FILE = '''\
"""Tests for the leetcode #10 artifact (regular expression matching).

Materialized into the grader's tmpdir alongside the agent-produced
solution.py. Pytest auto-discovers test_*.py files and imports
is_match from the same directory.

22 cases covering: LeetCode's canonical examples; empty-string and
empty-pattern edges; long quantifier chains; greedy `.*` overshoot;
trailing `*`; the 'must match entire string' invariant. Per-test
granularity is ~4.5% so the mechanical grader has real resolution
on partial implementations.
"""
from solution import is_match


# --- LeetCode canonical examples ---

def test_canonical_aa_a_false() -> None:
    assert is_match("aa", "a") is False


def test_canonical_aa_a_star_true() -> None:
    assert is_match("aa", "a*") is True


def test_canonical_ab_dot_star_true() -> None:
    assert is_match("ab", ".*") is True


def test_canonical_aab_c_star_a_star_b_true() -> None:
    assert is_match("aab", "c*a*b") is True


def test_canonical_mississippi_false() -> None:
    assert is_match("mississippi", "mis*is*p*.") is False


def test_canonical_mississippi_true() -> None:
    assert is_match("mississippi", "mis*is*ip*.") is True


# --- empty-string / empty-pattern edges ---

def test_empty_string_empty_pattern() -> None:
    assert is_match("", "") is True


def test_non_empty_string_empty_pattern() -> None:
    assert is_match("a", "") is False


def test_empty_string_zero_quantifier() -> None:
    """``a*`` matches zero a's, so empty string matches."""
    assert is_match("", "a*") is True


def test_empty_string_dot_star() -> None:
    assert is_match("", ".*") is True


def test_empty_string_long_zero_chain() -> None:
    """Long chain of optional quantifiers all consume zero."""
    assert is_match("", "a*b*c*") is True


# --- partial / full match invariant ---

def test_must_match_entire_string() -> None:
    """is_match('ab', 'a') is False — pattern must cover the whole string."""
    assert is_match("ab", "a") is False


def test_pattern_longer_than_string() -> None:
    assert is_match("a", "ab*") is True


def test_dot_star_with_trailing_required() -> None:
    """``.*c`` on 'ab' is False because there's no 'c' anywhere."""
    assert is_match("ab", ".*c") is False


# --- greedy / quantifier interactions ---

def test_a_star_greedy_then_a() -> None:
    """``a*a`` on 'aaa' — a* takes 2, then 'a' matches the last."""
    assert is_match("aaa", "a*a") is True


def test_a_star_consumes_all_then_required_a() -> None:
    """``a*`` could greedily take all 3 'a's but then 'a' has nothing —
    correct: backtrack so a* takes 2 and trailing 'a' matches one."""
    assert is_match("aaaa", "a*a") is True


def test_dot_star_greedy_with_trailing_dot() -> None:
    """``.*..`` on 'aaa' must NOT let .* consume all three — needs to
    leave 2 chars for the trailing dots."""
    assert is_match("aaa", ".*..") is True


def test_dot_star_too_short_for_trailing() -> None:
    assert is_match("a", ".*..") is False


# --- nested quantifiers ---

def test_a_star_b_star_a_star() -> None:
    """``a*b*a*`` matches anything composed of a's and b's where a's
    come before any b's, then a's again — including empty string."""
    assert is_match("aabba", "a*b*a*") is True


def test_a_star_b_star_a_star_empty() -> None:
    assert is_match("", "a*b*a*") is True


def test_alternating_zero_quantifiers() -> None:
    """``ab*c*`` on 'a': b* and c* both match zero."""
    assert is_match("a", "ab*c*") is True


# --- adversarial corner ---

def test_dot_quantifier_only() -> None:
    """``.*`` matches anything including the empty string."""
    assert is_match("xyz", ".*") is True
'''


def make_leetcode_regex_matching_grader_factory() -> GraderFactory:
    """Build a grader factory for :func:`code_leetcode_regex_matching`.

    Same mechanical pipeline as the other leetcode targets
    (pytest + mypy against solution.py in a tmpdir), with 22
    canonical regex-matching test cases. Picked for partial-credit
    discrimination: most agents pass the canonical LeetCode examples
    but stumble on the greedy/backtrack cases (``.*..``, ``a*a`` on
    long inputs) and empty-pattern corners — so cells score across
    the 0..1 range rather than clustering at the ceiling.
    """

    def factory(target: TargetConfig) -> Grader:
        # Wiring guard — see longest-substring factory for rationale.
        if target.name != "code_leetcode_regex_matching":
            raise ValueError(
                f"regex-matching grader factory called with "
                f"target {target.name!r}"
            )
        return _LeetcodeMechanicalGrader(
            test_file_content=_REGEX_MATCHING_TEST_FILE
        )

    return factory


# --- code grader: leetcode #4 (median of two sorted arrays) -------------


_MEDIAN_TWO_SORTED_ARRAYS_TEST_FILE = '''\
"""Tests for the leetcode #4 artifact (median of two sorted arrays).

Materialized into the grader's tmpdir alongside the agent-produced
solution.py. Pytest auto-discovers test_*.py files and imports
solution from the same directory.
"""
from solution import find_median_sorted_arrays


def test_canonical_odd_total() -> None:
    assert find_median_sorted_arrays([1, 3], [2]) == 2.0


def test_canonical_even_total() -> None:
    assert find_median_sorted_arrays([1, 2], [3, 4]) == 2.5


def test_all_zeros() -> None:
    assert find_median_sorted_arrays([0, 0], [0, 0]) == 0.0


def test_first_empty() -> None:
    assert find_median_sorted_arrays([], [1]) == 1.0


def test_second_empty() -> None:
    assert find_median_sorted_arrays([2], []) == 2.0


def test_second_empty_pair() -> None:
    assert find_median_sorted_arrays([], [2, 3]) == 2.5


def test_negatives_and_positives() -> None:
    assert (
        find_median_sorted_arrays(
            [-5, 3, 6, 12, 15], [-12, -10, -6, -3, 4, 10]
        )
        == 3.0
    )


def test_disjoint_first_smaller() -> None:
    assert find_median_sorted_arrays([1, 2, 3], [4, 5, 6]) == 3.5


def test_disjoint_first_larger() -> None:
    assert find_median_sorted_arrays([7, 8, 9], [1, 2, 3]) == 5.0


def test_duplicate_across_arrays() -> None:
    """Both arrays contain 5; median should still be the middle of
    the merged sorted view, not deduplicated."""
    assert find_median_sorted_arrays([1, 5, 9], [2, 5, 8]) == 5.0


def test_single_element_each_odd_total() -> None:
    """Two singletons + an odd-total via one-empty path differ; this
    pair is even-total so median is the average."""
    assert find_median_sorted_arrays([3], [7]) == 5.0


def test_long_skewed_arrays() -> None:
    """Imbalanced sizes exercise the binary-search-on-the-smaller-array
    invariant — solutions that always partition the first array fail
    when nums1 is the larger one."""
    nums1 = list(range(0, 100))
    nums2 = list(range(100, 105))
    # Combined has 105 elements; median is index 52.
    assert find_median_sorted_arrays(nums1, nums2) == 52.0


def test_returns_float_type() -> None:
    """Return type must be float even when the median is a whole
    number — the brief is explicit about this."""
    result = find_median_sorted_arrays([1, 2, 3], [])
    assert isinstance(result, float)
    assert result == 2.0
'''


# Perf test: time the agent's function call alone (excluding setup
# overhead) and fail if it exceeds the budget. signal.SIGALRM is a
# safety net for genuinely-hung solutions so the grader subprocess
# doesn't sit at the outer pytest timeout for the full 30s.
#
# Sizing tuned empirically on the dev box, then halved for portability
# (~280MB of int allocations was OOM-fragile on smaller runners):
#   - 3M elements per array, 6M combined (~170MB allocations)
#   - O(log(min(m,n))) partition: ~10µs
#   - O(m+n) pure-Python merge: ~270ms (CPython is fast at int
#     comparisons; we still need an order of magnitude more elements
#     than the leetcode editorial suggests to push the merge past
#     a tight budget)
#   - O(m*n) brute force: instant timeout
#   - O((m+n) log(m+n)) sorted(): ~50ms — would slip past the
#     wall-clock budget because timsort is C-optimized, but the perf
#     test runs an AST guard against the artifact's source first
#     and fails on any ``sorted(...)`` or ``.sort()`` call. The
#     mechanical guard catches canonical spellings; obscure
#     indirections (e.g. ``s = sorted; s(...)``) still slip but the
#     common cheat is closed.
# Function-call budget of 100ms catches pure-Python O(m+n) with ~2.7x
# margin while leaving 4 orders of magnitude of headroom for the
# partition algorithm. GC noise on a typical Python runtime sits in
# the 1-30ms range, so the budget gives ~3x margin to jitter on the
# fail side and effectively no risk on the pass side.
_MEDIAN_TWO_SORTED_ARRAYS_PERF_TEST_FILE = '''\
"""Perf test for the leetcode #4 artifact.

Times the agent's solution on a large-input case. Slow algorithms
(O(m+n) merge in pure Python, O(m*n) brute force) exceed the budget
and fail; the O(log(min(m, n))) partition algorithm returns in
microseconds and passes with several orders of magnitude of headroom.

Materialized into the grader's tmpdir alongside ``test_solution.py``;
the grader scopes pytest to this file via ``test_paths=`` so perf
runs aren't mixed into the correctness ``tests`` dimension.

Platform: ``signal.SIGALRM`` and ``signal.alarm`` are POSIX-only.
The harness targets Linux (homelab) and macOS (dev); Windows isn't
supported and this file would crash with ``AttributeError`` on
import there. If Windows ever needs to run this, swap the alarm
for a ``threading.Timer`` fallback.
"""
import ast
import signal
import time
from pathlib import Path

import pytest

from solution import find_median_sorted_arrays


_FUNCTION_CALL_BUDGET_S = 0.1
_HANG_SAFETY_NET_S = 25


class _PerfTimeout(Exception):
    pass


def _raise_timeout(_signum: int, _frame: object) -> None:
    raise _PerfTimeout()


def _assert_no_full_sort_in_solution() -> None:
    """Static-analysis guard: fail the perf test if the agent's
    solution.py contains ``sorted(...)`` or any ``.sort()`` call.

    The brief forbids those approaches because they're correctness-
    equivalent to the partition algorithm but exploit CPython's
    C-optimized timsort to slip under the wall-clock budget. Without
    this guard a sort-then-pick solution scores 1.0 on perf, which
    isn't the discrimination signal the target was added for.

    AST-level matching catches the canonical cases (``sorted(x)``,
    ``x.sort()``). It does NOT catch obscure indirections (``sortd =
    sorted; sortd(x)`` or ``getattr(x, 'sort')()``); operators who
    care about those cases can spot-check the artifact, but the
    common-case loophole is closed.
    """
    src = Path(__file__).with_name("solution.py").read_text(
        encoding="utf-8"
    )
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if (
            isinstance(node.func, ast.Name)
            and node.func.id == "sorted"
        ):
            pytest.fail(
                "perf forbids ``sorted(...)``: the brief requires an "
                "O(log(min(m, n))) partition; sort-then-pick is "
                "O((m+n) log(m+n)) and fails the spirit of the rubric"
            )
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "sort"
        ):
            pytest.fail(
                "perf forbids ``.sort()``: the brief requires an "
                "O(log(min(m, n))) partition; in-place sort is "
                "O((m+n) log(m+n)) and fails the spirit of the rubric"
            )


def test_perf_large_disjoint_arrays() -> None:
    """nums1 holds [0..N), nums2 holds [N..2N). True median is the
    midpoint of the seam — N - 0.5 — so wrong solutions are
    detectable, not just slow.

    Two budgets layered:
    - function-call budget (100ms, see ``_FUNCTION_CALL_BUDGET_S``)
      timed around the call only, so list-allocation jitter doesn't
      bleed into the perf score
    - hang safety net (25s) via SIGALRM covers the whole test for
      genuinely-stuck solutions; lets the test fail cleanly before
      the outer grader-level subprocess timeout fires
    """
    _assert_no_full_sort_in_solution()

    n = 3_000_000
    nums1 = list(range(0, n))
    nums2 = list(range(n, 2 * n))
    expected = float(n) - 0.5

    # Capture the prior SIGALRM handler so we can restore it on the
    # way out. Some pytest plugins install their own handler; leaving
    # ours in place would break them on subsequent tests.
    prev_handler = signal.signal(signal.SIGALRM, _raise_timeout)
    signal.alarm(_HANG_SAFETY_NET_S)
    try:
        start = time.perf_counter()
        result = find_median_sorted_arrays(nums1, nums2)
        elapsed = time.perf_counter() - start
    except _PerfTimeout:
        pytest.fail(
            f"perf hang: solution did not return within "
            f"{_HANG_SAFETY_NET_S}s on a 2x{n}-element input."
        )
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, prev_handler)

    assert result == expected, (
        f"correctness failure on the perf input: got {result}, "
        f"expected {expected}"
    )
    assert elapsed < _FUNCTION_CALL_BUDGET_S, (
        f"perf budget exceeded: function call took {elapsed:.2f}s, "
        f"budget is {_FUNCTION_CALL_BUDGET_S}s on a 2x{n}-element "
        f"input. The brief requires O(log(min(m, n))) time."
    )
'''


def make_leetcode_median_two_sorted_arrays_grader_factory() -> GraderFactory:
    """Build a grader factory for :func:`code_leetcode_median_two_sorted_arrays`.

    First v1 grader to use the perf dimension. Pipeline:

    - ``tests`` — 13 canonical correctness cases (small inputs)
    - ``mypy`` — strict typecheck via the standard pyproject stub
    - ``perf`` — one large-input case (2 × 3M = 6×10^6 elements)
      timed around the function call only, with a 100ms wall-clock
      budget. O(log(min(m,n))) finishes in microseconds; pure-Python
      O(m+n) merge takes ~270ms and fails the budget by ~2.7x. A
      SIGALRM safety net covers the whole test for genuinely-stuck
      solutions. An AST guard runs before the timing test and fails
      on any ``sorted(...)`` or ``.sort()`` call in solution.py —
      C-optimized timsort would otherwise slip under the wall-clock
      budget despite being the wrong algorithm.

    The perf dimension is the discrimination point this target was
    added for. A "passes tests but fails perf" cell tells us the
    agent solved the problem functionally but didn't meet the
    complexity bound — exactly the signal weak open models will
    typically produce on this target.
    """

    def factory(target: TargetConfig) -> Grader:
        # Wiring guard — see longest-substring factory for rationale.
        if target.name != "code_leetcode_median_two_sorted_arrays":
            raise ValueError(
                f"median-two-sorted-arrays grader factory called with "
                f"target {target.name!r}"
            )
        return _LeetcodeMechanicalGrader(
            test_file_content=_MEDIAN_TWO_SORTED_ARRAYS_TEST_FILE,
            perf_test_content=_MEDIAN_TWO_SORTED_ARRAYS_PERF_TEST_FILE,
        )

    return factory


def make_leetcode_trapping_rain_water_grader_factory() -> GraderFactory:
    """Build a grader factory for :func:`code_leetcode_trapping_rain_water`.

    Same mechanical pipeline as the longest-substring factory
    (pytest + mypy against solution.py in a tmpdir), only the test
    file string differs — 11 canonical trapping-rain-water cases
    covering the standard examples plus edge cases (empty, single,
    two-element, flat, monotonic, pyramid, multi-basin) that trip
    naive implementations.
    """

    def factory(target: TargetConfig) -> Grader:
        # Wiring guard — see longest-substring factory for rationale.
        if target.name != "code_leetcode_trapping_rain_water":
            raise ValueError(
                f"trapping-rain-water grader factory called with "
                f"target {target.name!r}"
            )
        return _LeetcodeMechanicalGrader(
            test_file_content=_TRAPPING_RAIN_WATER_TEST_FILE
        )

    return factory
