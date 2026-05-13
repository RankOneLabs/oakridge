"""Construct + run the planner 1 agent."""
from __future__ import annotations

import os
from datetime import datetime
from typing import Any

from jig.core.runner import AgentConfig, run_agent
from jig.core.types import EvalCase, FeedbackLoop, FeedbackQuery, Score, ScoredResult, ScoreSource
from jig.llm.factory import from_model
from jig.tools.registry import ToolRegistry
from jig.tracing.stdout import StdoutTracer

from .staging import StagingBuffer
from .tools import AddCohortDependencyTool, CreateCohortTool

PLANNER1_SYSTEM_PROMPT = """\
You are planner 1: you produce a plan of cohorts for a software-engineering
spec. Each cohort is a parallelizable unit of work that a build agent
(Sonnet/Haiku tier) can execute. The plan lands in safir for operator
review before any build work begins.

Make all structural decisions. No optional choices. If any decision
about the decomposition is not decided it must be explicitly punted to
later work; silent omission is the failure mode you are guarding
against. "Punted" means: the unresolved decision is named in your final
summary message with (a) what the decision is, (b) the option you'd
pick if forced, (c) why you're deferring instead. Do not silently leave
work out of the plan because you weren't sure where it goes.

Inputs:
- The spec (passed as the agent's initial message; this is the
  tasks.notes of the parent task you're decomposing).
- The parent task's metadata (id, project_id) appears appended below.

Output: zero or more tool calls to create cohorts and dependencies,
followed by a final assistant message summarizing the plan.
The summary names every explicit punt, in the (a)/(b)/(c) shape above,
so the operator can review whether each deferral is acceptable.

Tools:
- create_cohort(title, notes, priority?) — stage a cohort in the plan.
  Returns cohort_index (0-based) for use in add_cohort_dependency.
- add_cohort_dependency(cohort_index, depends_on_cohort_index) — declare
  that cohort_index cannot start until depends_on_cohort_index is done.
  Indices are 0-based, in the order create_cohort was called. Cycles
  are rejected.

Rules for cohorts:
- Each cohort is sized so a build agent (Sonnet/Haiku tier) could
  execute it without significant judgment calls.
- A cohort that requires significant judgment to execute is too big;
  split it.
- Each cohort states its goal, the surface area it touches, and the
  exit criteria that mark it done. Notes field is markdown.
- Cohorts should be independently buildable wherever possible; prefer
  parallelism over sequencing.

Rules for dependencies:
- Only add a dependency edge when cohort B cannot start until cohort A
  is done in the working tree. Conceptual ordering ("A is more
  fundamental") is not a dependency.
- Cycles are an error; the tool will reject them.

Operator approval gate: your tool calls land in a safir plan for
operator review. The operator approves or rejects the plan before any
build agent begins work.
"""


class NoOpFeedback(FeedbackLoop):  # type: ignore[misc]
    """Stub FeedbackLoop for planner1; no signals, no storage."""

    async def store_result(
        self,
        content: str,
        input_text: str,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        return "noop"

    async def score(self, result_id: str, scores: list[Score]) -> None:
        return None

    async def get_signals(
        self,
        query: str,
        limit: int = 3,
        min_score: float | None = None,
        source: ScoreSource | None = None,
    ) -> list[ScoredResult]:
        return []

    async def query(self, q: FeedbackQuery) -> list[ScoredResult]:
        return []

    async def export_eval_set(
        self,
        since: datetime | None = None,
        min_score: float | None = None,
        max_score: float | None = None,
        limit: int | None = None,
    ) -> list[EvalCase]:
        return []


def load_system_prompt() -> str:
    override = os.environ.get("PLANNER1_SYSTEM_PROMPT_PATH")
    if override:
        with open(override) as f:
            return f.read()
    return PLANNER1_SYSTEM_PROMPT


async def run_planner1(
    *,
    parent_task_id: int,
    task_notes: str,
    project_id: str,
    model: str = "claude-opus-4-7",
) -> tuple[StagingBuffer, str]:
    """Run the planner 1 agent. Returns (buffer, agent_summary_text)."""
    buffer = StagingBuffer(parent_task_id=parent_task_id)
    tools = ToolRegistry([CreateCohortTool(buffer), AddCohortDependencyTool(buffer)])

    system_prompt = (
        load_system_prompt()
        + f"\n\nParent task context: id={parent_task_id}, project_id={project_id}\n"
    )

    config: AgentConfig[None] = AgentConfig(
        name="planner1",
        description="Produces a plan of cohorts for a software-engineering spec.",
        system_prompt=system_prompt,
        llm=from_model(model),
        feedback=NoOpFeedback(),
        tracer=StdoutTracer(color=False),
        tools=tools,
        max_tool_calls=60,
        max_llm_calls=80,
    )
    result = await run_agent(config, task_notes)
    summary = result.output or ""
    return buffer, summary
