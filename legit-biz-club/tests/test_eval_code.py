"""Tests for code-eval primitives.

Heuristic Check construction is straightforward; the trickier paths
are pytest-summary parsing and the timeout / nonexistent-command
fallbacks. We test both the score functions directly and a full
``run_command_check`` round-trip via ``echo``-style commands.
"""
from __future__ import annotations

from jig.feedback.heuristic import HeuristicGrader

from legit_biz_club.eval.code import (
    CommandResult,
    _score_pytest,
    _score_zero_one,
    pytest_check,
    run_command_check,
)

# --- score functions ----------------------------------------------------


def test_score_pytest_all_pass() -> None:
    result = CommandResult(returncode=0, stdout="3 passed in 0.01s", stderr="")
    assert _score_pytest(result) == 1.0


def test_score_pytest_partial() -> None:
    result = CommandResult(
        returncode=1,
        stdout="2 passed, 1 failed in 0.02s",
        stderr="",
    )
    assert abs(_score_pytest(result) - (2 / 3)) < 1e-9


def test_score_pytest_with_errors() -> None:
    """Errors count as failures alongside failed tests."""
    result = CommandResult(
        returncode=1,
        stdout="1 passed, 1 failed, 1 error in 0.03s",
        stderr="",
    )
    assert abs(_score_pytest(result) - (1 / 3)) < 1e-9


def test_score_pytest_no_tests_found() -> None:
    """Collection error / no tests is a 0.0 — failure to reach tests
    is worse than a test that failed cleanly."""
    result = CommandResult(
        returncode=5, stdout="no tests ran", stderr=""
    )
    assert _score_pytest(result) == 0.0


def test_score_pytest_skipped_only() -> None:
    """All-skipped also scores 0.0 (no actual passes)."""
    result = CommandResult(returncode=0, stdout="2 skipped in 0.01s", stderr="")
    assert _score_pytest(result) == 0.0


def test_score_zero_one() -> None:
    assert _score_zero_one(CommandResult(0, "", "")) == 1.0
    assert _score_zero_one(CommandResult(1, "", "")) == 0.0
    assert _score_zero_one(CommandResult(2, "", "")) == 0.0


# --- run_command_check round-trip --------------------------------------


async def test_run_command_check_success() -> None:
    """A command that exits 0 scores 1.0 under _score_zero_one."""
    check = run_command_check(
        name="echo-success",
        cmd=["true"],
        score=_score_zero_one,
    )
    assert callable(check.pattern)
    score = check.pattern("ignored", "ignored")  # type: ignore[operator]
    assert score == 1.0


async def test_run_command_check_failure() -> None:
    """A command that exits non-zero scores 0.0."""
    check = run_command_check(
        name="echo-fail",
        cmd=["false"],
        score=_score_zero_one,
    )
    score = check.pattern("ignored", "ignored")  # type: ignore[operator]
    assert score == 0.0


async def test_run_command_check_timeout_returns_zero() -> None:
    """A command that exceeds the timeout scores 0.0 rather than
    propagating the TimeoutExpired exception — eval failure is a
    score, not an exception."""
    check = run_command_check(
        name="sleeps-too-long",
        cmd=["sleep", "5"],
        score=_score_zero_one,
        timeout_s=0.1,
    )
    score = check.pattern("ignored", "ignored")  # type: ignore[operator]
    assert score == 0.0


async def test_run_command_check_clamps_score() -> None:
    """Score functions that return out-of-range values get clamped."""

    def _bad_score(_r: CommandResult) -> float:
        return 5.0  # out of range

    check = run_command_check(
        name="oversize", cmd=["true"], score=_bad_score
    )
    score = check.pattern("ignored", "ignored")  # type: ignore[operator]
    assert score == 1.0


async def test_run_command_check_clamps_negative() -> None:
    def _neg_score(_r: CommandResult) -> float:
        return -2.0

    check = run_command_check(
        name="neg", cmd=["true"], score=_neg_score
    )
    score = check.pattern("ignored", "ignored")  # type: ignore[operator]
    assert score == 0.0


# --- HeuristicGrader integration ---------------------------------------


async def test_grader_wraps_check_output_in_score() -> None:
    """End-to-end: building a HeuristicGrader from a Check and
    calling its grade() produces a Score."""
    check = run_command_check(
        name="sanity",
        cmd=["true"],
        score=_score_zero_one,
    )
    grader = HeuristicGrader([check])
    scores = await grader.grade(input="x", output="y")
    assert len(scores) == 1
    assert scores[0].dimension == "sanity"
    assert scores[0].value == 1.0


# --- pytest_check covers the full surface (just ensures it builds) ----


def test_pytest_check_builds_a_check() -> None:
    """We don't run pytest-on-pytest in the test suite; just verify
    the constructor produces a Check with the right name."""
    from pathlib import Path

    check = pytest_check(Path("tests"))
    assert check.name == "pytest"
    assert callable(check.pattern)
