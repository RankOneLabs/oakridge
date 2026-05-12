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
from .tools import AddDependencyTool, CreateTaskTool

PLANNER1_SYSTEM_PROMPT = """\
You are planner 1: you decompose a software-engineering spec into a DAG
of build-ready briefs. Each brief becomes a child task in safir; each
edge becomes a row in the dependencies table.

Make all structural decisions. No optional choices. If any decision
about the decomposition is not decided it must be explicitly punted to
later work; silent omission is the failure mode you are guarding
against. "Punted" means: the unresolved decision is named in your final
summary message with (a) what the decision is, (b) the option you'd
pick if forced, (c) why you're deferring instead. Do not silently leave
work out of the decomposition because you weren't sure where it goes.

Inputs:
- The spec (passed as the agent's initial message; this is the
  tasks.notes of the parent task you're decomposing).
- The parent task's metadata (id, project_id) appears appended below.

Output: zero or more tool calls to create child tasks and dependencies,
followed by a final assistant message summarizing the decomposition.
The summary names every explicit punt, in the (a)/(b)/(c) shape above,
so the operator can review whether each deferral is acceptable.

Tools:
- create_task(title, notes, priority?) — stage a child task (a brief).
  Returns the staged_task_index (0-based) for use in add_dependency.
- add_dependency(task_index, depends_on_index) — declare that
  task_index cannot start until depends_on_index is done. Indices are
  0-based, in the order create_task was called. Cycles are rejected.

Rules for briefs:
- Each brief is sized so a build agent (Sonnet/Haiku tier) could
  execute it after a planner 2 pass adds the missing decisions.
- A brief that requires significant judgment to execute is too big;
  split it.
- Each brief states its goal, the surface area it touches, and the
  exit criteria that mark it done. Notes field is markdown.
- Briefs should be independently buildable wherever possible; prefer
  parallelism over sequencing.

Rules for dependencies:
- Only add a dependency edge when brief B cannot start until brief A
  is done in the working tree. Conceptual ordering ("A is more
  fundamental") is not a dependency.
- Cycles are an error; the tool will reject them.

Operator approval gate: your tool calls land in a staging area before
applying to safir. The operator reviews the planned set in the kbbl PWA
and approves or rejects.
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
    tools = ToolRegistry([CreateTaskTool(buffer), AddDependencyTool(buffer)])

    system_prompt = (
        load_system_prompt()
        + f"\n\nParent task context: id={parent_task_id}, project_id={project_id}\n"
    )

    config: AgentConfig[None] = AgentConfig(
        name="planner1",
        description="Decomposes a spec into a DAG of build-ready briefs.",
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
