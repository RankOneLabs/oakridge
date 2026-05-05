"""Prose-artifact eval primitive.

Wraps jig's :class:`LLMJudge` with the project brief's success
criteria as judge dimensions. The judge agent's :class:`LLMClient` is
distinct from the writer agents' (per the design memo: "the judge is
a separate jig-configured agent — distinct from the writing agents
both in identity and (by default) in underlying model — so judgments
aren't biased by self-evaluation").

Phase 4 ships the constructor; consumers wire the result into a jig
:class:`HeuristicGrader` / :class:`CompositeGrader` and run it
against the artifact's content at whatever checkpoint cadence the
project's eval loop dictates.
"""
from __future__ import annotations

from jig.core.types import LLMClient
from jig.feedback.llm_judge import LLMJudge

from legit_biz_club.core.models import Brief


def make_brief_judge(
    brief: Brief,
    judge_llm: LLMClient,
    *,
    extra_rubric: str = "",
) -> LLMJudge:
    """Build a jig :class:`LLMJudge` keyed on the brief's success criteria.

    Each entry in ``brief.success_criteria`` becomes one of the
    judge's dimensions; the judge scores a candidate prose artifact
    on each dimension independently. ``brief.target_spec`` and
    ``brief.constraints`` are folded into the rubric as overall
    context. ``extra_rubric`` appends project-specific guidance.

    Caller is responsible for using a ``judge_llm`` that's distinct
    from the writer agents' models (different model id, ideally
    different provider). This module doesn't enforce that — the
    writer/judge separation is a project-config decision.
    """
    if not brief.success_criteria:
        raise ValueError(
            "make_brief_judge requires brief.success_criteria to be "
            "non-empty — there's nothing to score otherwise"
        )

    rubric_parts: list[str] = [
        f"Target spec for the artifact:\n{brief.target_spec}",
    ]
    if brief.constraints:
        rubric_parts.append(
            "The artifact must respect these constraints:\n"
            + "\n".join(f"- {c}" for c in brief.constraints)
        )
    if extra_rubric:
        rubric_parts.append(extra_rubric)
    rubric = "\n\n".join(rubric_parts)

    return LLMJudge(
        llm=judge_llm,
        dimensions=list(brief.success_criteria),
        rubric=rubric,
    )
