"""Code-artifact eval primitives.

Built on jig's :class:`HeuristicGrader` + :class:`Check` — the
``pattern`` field of a Check accepts either a regex string OR a
callable ``(input, output) -> float``, and the callable mode lets us
score on the result of running an arbitrary subprocess.

v1 ships convenience constructors for the three standard tools:

- :func:`pytest_check` — fraction of tests passing (1.0 = all pass).
- :func:`mypy_check` — 1.0 on clean exit, 0.0 on any reported error.
- :func:`ruff_check` — same shape as mypy.

Plus :func:`run_command_check` for project-specific tools — pass any
shell command and a scoring function that turns its
:class:`CommandResult` into a 0..1 score.

The Check objects are typically composed into a jig
:class:`HeuristicGrader` or :class:`CompositeGrader` by the project's
eval configuration; this module doesn't impose a specific grader
shape.
"""
from __future__ import annotations

import re
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from jig.feedback.heuristic import Check


@dataclass(frozen=True, slots=True)
class CommandResult:
    """The shape a check's subprocess returns.

    ``returncode`` is the process exit code; ``stdout`` and ``stderr``
    are decoded text. Score functions receive a :class:`CommandResult`
    and return a ``[0.0, 1.0]`` float.
    """

    returncode: int
    stdout: str
    stderr: str


def run_command_check(
    name: str,
    cmd: Sequence[str],
    *,
    cwd: Path | None = None,
    score: Callable[[CommandResult], float],
    timeout_s: float | None = 60.0,
) -> Check:
    """Build a jig :class:`Check` that runs ``cmd`` and grades via ``score``.

    The returned Check's pattern is a callable that, when invoked,
    runs the subprocess and feeds the result to ``score``. The Check's
    contract from jig (``pattern: Callable[[str, str], float]``)
    expects ``(input, output)``; we ignore those and let the subprocess
    speak for itself.

    ``timeout_s`` defaults to 60 seconds — enough for unit tests and
    type-checks on small repos, finite enough that a hung tool can't
    stall the project. Set to ``None`` for no timeout.
    """

    def _runner(_input: str, _output: str) -> float:
        try:
            completed = subprocess.run(
                list(cmd),
                cwd=str(cwd) if cwd is not None else None,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return 0.0
        except OSError:
            # FileNotFoundError when the executable isn't on PATH;
            # PermissionError when it isn't executable; etc. Treat
            # any of these as a failed check rather than letting the
            # exception escape and abort the grader.
            return 0.0
        result = CommandResult(
            returncode=completed.returncode,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
        )
        try:
            return _clamp(score(result))
        except Exception:
            # ``score`` is operator-supplied — a buggy scorer
            # shouldn't take down the whole grading pass. Treat any
            # raise as a failed check (the same posture as
            # subprocess errors above).
            return 0.0

    return Check(name=name, pattern=_runner)


def pytest_check(
    test_dir: Path,
    *,
    name: str = "pytest",
    cwd: Path | None = None,
    timeout_s: float | None = 120.0,
    test_paths: Sequence[Path] | None = None,
) -> Check:
    """Run pytest under ``test_dir`` and return the fraction passing.

    Score is ``passed / (passed + failed + errors)`` derived from
    pytest's summary line. ``1.0`` means everything passed; ``0.0`` if
    pytest didn't run or every test failed. Errors during collection
    score as ``0.0`` (failure to even reach the tests is worse than a
    test that failed cleanly).

    ``test_paths``: when provided, run pytest against those specific
    files instead of letting it discover everything under ``test_dir``.
    Useful for splitting a single tmpdir's tests into multiple scored
    dimensions (e.g., a correctness suite and a perf suite materialized
    side-by-side, scored separately).
    """
    if test_paths is not None:
        targets = [str(p) for p in test_paths]
    else:
        targets = [str(test_dir)]
    return run_command_check(
        name=name,
        cmd=["pytest", *targets, "-q", "--tb=no"],
        cwd=cwd,
        score=_score_pytest,
        timeout_s=timeout_s,
    )


def mypy_check(
    src_dir: Path,
    *,
    name: str = "mypy",
    cwd: Path | None = None,
    timeout_s: float | None = 60.0,
) -> Check:
    """Run mypy on ``src_dir``. Score is 1.0 on clean exit, 0.0 otherwise.

    Binary by design — mypy either accepts the codebase or it doesn't,
    and partial scoring would obscure the signal. If a project wants
    fractional credit (e.g., counting reported errors) it can build a
    custom Check via :func:`run_command_check`.
    """
    return run_command_check(
        name=name,
        cmd=["mypy", str(src_dir)],
        cwd=cwd,
        score=_score_zero_one,
        timeout_s=timeout_s,
    )


def ruff_check(
    src_dir: Path,
    *,
    name: str = "ruff",
    cwd: Path | None = None,
    timeout_s: float | None = 30.0,
) -> Check:
    """Run ``ruff check`` on ``src_dir``. Same 1/0 shape as mypy_check."""
    return run_command_check(
        name=name,
        cmd=["ruff", "check", str(src_dir)],
        cwd=cwd,
        score=_score_zero_one,
        timeout_s=timeout_s,
    )


# --- score functions -----------------------------------------------------


_PYTEST_SUMMARY_RE = re.compile(
    r"(?P<count>\d+)\s+(?P<kind>passed|failed|error|errors|skipped)"
)


def _score_pytest(result: CommandResult) -> float:
    """Parse pytest's summary line and return passed / total."""
    counts: dict[str, int] = {
        "passed": 0,
        "failed": 0,
        "error": 0,
        "errors": 0,
        "skipped": 0,
    }
    for match in _PYTEST_SUMMARY_RE.finditer(result.stdout):
        kind = match.group("kind")
        counts[kind] = int(match.group("count"))
    failed = counts["failed"] + counts["error"] + counts["errors"]
    total = counts["passed"] + failed
    if total == 0:
        # No tests ran (collection error, no tests found, or the
        # summary line wasn't parseable). Treat as failure — failure
        # to reach the tests is worse than a test that failed cleanly.
        return 0.0
    return counts["passed"] / total


def _score_zero_one(result: CommandResult) -> float:
    return 1.0 if result.returncode == 0 else 0.0


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))
