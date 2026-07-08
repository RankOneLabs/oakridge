"""Tests for prose-eval primitive.

Light coverage — heavy LLMJudge logic is jig's responsibility (and
covered there). Here we verify the wrapper builds a jig LLMJudge with
the right dimensions and rubric assembled from a Brief.
"""

from __future__ import annotations

import json

import pytest
from jig.core.types import (
    CompletionParams,
    LLMClient,
    LLMResponse,
    Usage,
)
from jig.feedback.llm_judge import LLMJudge

from legit_biz_club import Brief
from legit_biz_club.eval.prose import make_brief_judge


def _scores_response(*dimensions: str) -> str:
    return json.dumps(
        {"scores": [{"dimension": dimension, "value": 1.0} for dimension in dimensions]}
    )


class _StubJudgeLLM(LLMClient):
    """Captures the system prompt + messages it received."""

    def __init__(self, response_content: str | None = None) -> None:
        # Default is enough for tests that only check construction.
        # Tests that call grade() pass dimensions matching the brief.
        self._response = (
            response_content if response_content is not None else _scores_response("stub")
        )
        self.last_params: CompletionParams | None = None

    async def complete(self, params: CompletionParams) -> LLMResponse:
        self.last_params = params
        return LLMResponse(
            content=self._response,
            tool_calls=None,
            usage=Usage(input_tokens=1, output_tokens=1),
            latency_ms=1.0,
            model="stub-judge",
        )


def test_returns_jig_llm_judge() -> None:
    """make_brief_judge produces a real jig LLMJudge — caller can plug
    it into HeuristicGrader / CompositeGrader / FeedbackLoop."""
    brief = Brief(target_spec="x", success_criteria=["a", "b"])
    judge = make_brief_judge(brief, _StubJudgeLLM())
    assert isinstance(judge, LLMJudge)


def test_rejects_empty_success_criteria() -> None:
    brief = Brief(target_spec="x", success_criteria=[])
    with pytest.raises(ValueError, match="success_criteria"):
        make_brief_judge(brief, _StubJudgeLLM())


async def test_rubric_includes_target_spec_and_constraints() -> None:
    """target_spec and constraints fold into the rubric so the judge
    sees them as overall context (not as scored dimensions)."""
    brief = Brief(
        target_spec="ship a one-paragraph summary",
        success_criteria=["under 100 words", "uses plain language"],
        constraints=["no marketing speak"],
    )
    llm = _StubJudgeLLM(response_content=_scores_response("under 100 words", "uses plain language"))
    judge = make_brief_judge(brief, llm)
    await judge.grade(input="brief", output="some draft")
    assert llm.last_params is not None
    system = llm.last_params.system or ""
    assert "ship a one-paragraph summary" in system
    assert "no marketing speak" in system
    # Dimensions also surface (jig's LLMJudge embeds them in the
    # template too).
    assert "under 100 words" in system
    assert "uses plain language" in system


async def test_extra_rubric_appended() -> None:
    brief = Brief(target_spec="x", success_criteria=["dim"])
    llm = _StubJudgeLLM(response_content=_scores_response("dim"))
    judge = make_brief_judge(brief, llm, extra_rubric="Be strict about citations.")
    await judge.grade(input="x", output="y")
    assert llm.last_params is not None
    assert "Be strict about citations." in (llm.last_params.system or "")


async def test_dimensions_come_from_success_criteria() -> None:
    """Each entry in brief.success_criteria becomes a judge dimension
    in the same order."""
    brief = Brief(
        target_spec="x",
        success_criteria=["dimension_a", "dimension_b", "dimension_c"],
    )
    canned = json.dumps(
        {
            "scores": [
                {"dimension": "dimension_a", "value": 0.9},
                {"dimension": "dimension_b", "value": 0.5},
                {"dimension": "dimension_c", "value": 0.1},
            ]
        }
    )
    llm = _StubJudgeLLM(response_content=canned)
    judge = make_brief_judge(brief, llm)
    scores = await judge.grade(input="x", output="y")
    assert [s.dimension for s in scores] == [
        "dimension_a",
        "dimension_b",
        "dimension_c",
    ]
    assert scores[0].value == 0.9
    assert scores[1].value == 0.5
    assert scores[2].value == 0.1
