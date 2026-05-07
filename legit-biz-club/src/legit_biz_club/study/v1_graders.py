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
- :func:`make_leetcode_longest_substring_grader_factory` and
  :func:`make_leetcode_trapping_rain_water_grader_factory` — both
  wrap a generic mechanical grader that materializes the artifact +
  a per-target test file + a stub pyproject.toml into a tmpdir,
  then runs pytest + mypy. The two factories share the grader; only
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
    into a tmpdir, then runs pytest / mypy / ruff against it via
    jig's :class:`HeuristicGrader`.

    Test-file content is injected at construction so the same grader
    class serves any leetcode-shaped target (longest-substring,
    trapping-rain-water, future Hard problems). Adding a new code
    target now means defining a test file string + wiring a new
    factory — no new grader class.

    The tmpdir lives only for the duration of the ``grade()`` call —
    we don't keep the artifact lying around because the cell's
    ``solution.py`` (under ``.run/<ts>/...``) is the durable copy. The
    tmpdir is purely for the subprocess checks that need a real
    file on disk.
    """

    def __init__(self, *, test_file_content: str) -> None:
        self._test_file = test_file_content

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
            (dpath / "test_solution.py").write_text(
                self._test_file, encoding="utf-8"
            )
            heuristic = HeuristicGrader(
                checks=[
                    pytest_check(dpath, name="tests", cwd=dpath),
                    mypy_check(dpath, name="mypy", cwd=dpath),
                ]
            )
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

    def factory(_target: TargetConfig) -> Grader:
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

    def factory(_target: TargetConfig) -> Grader:
        return _LeetcodeMechanicalGrader(
            test_file_content=_REGEX_MATCHING_TEST_FILE
        )

    return factory


def make_leetcode_trapping_rain_water_grader_factory() -> GraderFactory:
    """Build a grader factory for :func:`code_leetcode_trapping_rain_water`.

    Same mechanical pipeline as the longest-substring factory
    (pytest + mypy + ruff against solution.py in a tmpdir), only the
    test file string differs — 11 canonical trapping-rain-water cases
    covering the standard examples plus edge cases (empty, single,
    two-element, flat, monotonic, pyramid, multi-basin) that trip
    naive implementations.
    """

    def factory(_target: TargetConfig) -> Grader:
        return _LeetcodeMechanicalGrader(
            test_file_content=_TRAPPING_RAIN_WATER_TEST_FILE
        )

    return factory
