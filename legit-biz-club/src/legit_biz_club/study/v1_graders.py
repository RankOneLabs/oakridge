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
- :func:`make_leetcode_longest_substring_grader_factory` — runs the
  artifact through pytest + mypy + ruff. The 8 canonical leetcode
  cases live as a string constant materialized into a tmpdir per
  grade call so subprocess-based checks have something to point at.

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
    ruff_check,
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
    cheap, strong reasoner, distinct from Opus. Override for
    production studies: the judge should ideally be in a different
    provider from the writer pool so identity-driven self-bias is
    impossible. The smoke pool is Anthropic-only by default; pinning
    the judge to OpenAI or Google needs that provider's API key.
    """
    llm = judge_llm if judge_llm is not None else from_model(_DEFAULT_JUDGE_MODEL)

    def factory(target: TargetConfig) -> Grader:
        return make_brief_judge(target.brief, judge_llm=llm)

    return factory


# --- code grader ---------------------------------------------------------


# Stub pyproject.toml materialized in the grader's tmpdir so ruff
# and mypy run with the project's strictness, not their defaults.
# Without this, ruff falls back to its default rule set (which
# doesn't include W*, so W292 trailing-newline doesn't fire) and
# mypy falls back to non-strict (no required annotations, etc.) —
# the brief's "passes ruff lint with project defaults" /
# "type-checks under strict mypy" criteria would silently grade as
# lenient pass-throughs. Mirrors legit-biz-club's pyproject.toml
# tool sections; keep in sync if the project's lint/typecheck
# config drifts.
_PROJECT_PYPROJECT_STUB = """\
[tool.ruff]
target-version = "py312"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B", "SIM"]

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


class _LeetcodeLongestSubstringGrader:
    """Grader that materializes the artifact + tests into a tmpdir,
    then runs pytest / mypy / ruff against it via jig's
    :class:`HeuristicGrader`.

    The tmpdir lives only for the duration of the ``grade()`` call —
    we don't keep the artifact lying around because the cell's
    ``solution.py`` (under ``.run/<ts>/...``) is the durable copy. The
    tmpdir is purely for the subprocess checks that need a real
    file on disk.
    """

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
                _LEETCODE_TEST_FILE, encoding="utf-8"
            )
            heuristic = HeuristicGrader(
                checks=[
                    pytest_check(dpath, name="tests", cwd=dpath),
                    mypy_check(dpath, name="mypy", cwd=dpath),
                    ruff_check(dpath, name="ruff", cwd=dpath),
                ]
            )
            scores: list[Score] = await heuristic.grade(
                input, output, context
            )
            return scores


def make_leetcode_longest_substring_grader_factory() -> GraderFactory:
    """Build a grader factory for :func:`code_leetcode_longest_substring`.

    Returns a grader that, on each ``grade()`` call, writes the
    artifact + a fixed test file into a fresh tmpdir, then runs:

    - pytest against the 8 canonical leetcode #3 cases
    - mypy on solution.py (uses the project's mypy defaults via
      :func:`mypy_check`)
    - ruff on solution.py (project defaults via :func:`ruff_check`)

    Each check returns a 0..1 score. ``HeuristicGrader`` aggregates
    them into one :class:`Score` per check name. No LLM calls — fully
    mechanical — so this grader is cheap and deterministic compared
    to the prose judge.
    """

    def factory(_target: TargetConfig) -> Grader:
        return _LeetcodeLongestSubstringGrader()

    return factory
