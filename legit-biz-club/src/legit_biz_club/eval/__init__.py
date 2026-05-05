"""Eval primitives for the workspace layer.

Two domains, two primitives:

- :mod:`legit_biz_club.eval.code` — code-artifact eval. Wraps jig's
  :class:`HeuristicGrader` with subprocess-running ``Check`` factories
  for the standard tools (pytest, mypy, ruff) plus an extension hook
  for project-specific commands.
- :mod:`legit_biz_club.eval.prose` — prose-artifact eval. Wraps jig's
  :class:`LLMJudge` with the project brief's success criteria as
  judge dimensions; the judge agent's LLM is distinct from the writer
  agents' (per the design memo).

Both feed jig's score primitives, so eval results travel through
``FeedbackLoop`` and trajectory grading the same as any other jig
score. Phase 4 doesn't introduce new score plumbing — it just builds
the grader objects that consume the existing one.
"""

from legit_biz_club.eval.code import (
    CommandResult,
    mypy_check,
    pytest_check,
    ruff_check,
    run_command_check,
)
from legit_biz_club.eval.prose import make_brief_judge

__all__ = [
    "CommandResult",
    "make_brief_judge",
    "mypy_check",
    "pytest_check",
    "ruff_check",
    "run_command_check",
]
