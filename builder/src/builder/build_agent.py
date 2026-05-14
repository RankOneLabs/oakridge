"""Build agent step: execute a handoff into PRs + debrief."""
from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from jig.core.runner import AgentConfig, run_agent
from jig.llm.factory import from_model
from jig.tools.registry import ToolRegistry
from jig.tracing.stdout import StdoutTracer
from pydantic import BaseModel, Field

from .feedback import NoOpFeedback
from .tools import (
    BashTool,
    BuildContext,
    EditTool,
    GlobTool,
    GrepTool,
    ReadTool,
    WriteTool,
)

BUILD_AGENT_SYSTEM_PROMPT = """\
You are the build agent. Your input is a handoff doc produced by
planner 2. Your job is to execute it: implement the goal, complete the
active_subgoals in order, touch only files_in_scope unless something is
clearly missing.

You DO NOT make architectural decisions. If something is unclear or
conflicting, file a safir backlog task by calling Bash with:

  safir add <project_id> "<title>" --notes "<details>" --parent {current_task_id}

and continue with the most reasonable interpretation. Do not pause.

You operate in the working directory: {workdir}

When done with the work:
1. Create a branch named exactly: safir-build/{current_task_id}-{run_short_id}
2. Stage your changes (`git add <specific paths>` — never `git add -A`).
3. Commit. Push the branch (`git push -u origin <branch>`).
4. Open a PR with `gh pr create --base main --title "<title>" --body "<body>"`.
   The title should be the brief's goal one-liner; the body should be the
   brief itself, followed by the line:
       🤖 Generated with [Claude Code](https://claude.com/claude-code)
5. Capture the PR URL from `gh pr create` stdout.
6. Call the `submit_output` tool exactly once with your Debrief. The
   Debrief MUST include the PR URL(s) in pr_urls. If you opened multiple
   PRs (one per logical unit of work), include each URL as a separate
   list entry.

Available tools:
- Read(path, numbered?) — read a file as a raw string.
- Write(path, content) — overwrite/create a file.
- Edit(path, old_string, new_string, replace_all?) — substring replace.
- Bash(command, timeout_seconds?) — run a shell command in the workdir.
- Grep(pattern, path?, glob?, output_mode?, case_insensitive?, line_numbers?,
  head_limit?) — ripgrep search.
- Glob(pattern, path?) — find files matching a glob, sorted by mtime.

Constraints:
- Every path argument is resolved inside the workdir; paths that escape
  fail with an error.
- Bash commands are filtered against the run's permission profile; deny
  matches return an error result without executing.
- Never run destructive git commands (push --force, reset --hard,
  branch -D) unless the handoff explicitly requires them.
- Never bypass commit signing (no --no-gpg-sign, no --no-verify).
"""


class NotDeliveredItem(BaseModel):
    item: str
    reason: str = Field(..., description="One of: deferred|blocked|out_of_scope|failed")
    notes: str = ""


class DeviationItem(BaseModel):
    instruction: str
    actual: str
    rationale: str = ""


class BuildAgentOutput(BaseModel):
    delivered_summary: str
    not_delivered: list[NotDeliveredItem] = Field(default_factory=list)
    deviations: list[DeviationItem] = Field(default_factory=list)
    pr_urls: list[str] = Field(default_factory=list)


def _build_input(handoff_raw_markdown: str) -> str:
    return (
        "Execute the following handoff. Use the tools above. When the work "
        "is done, call submit_output once with your Debrief.\n\n"
        f"--- HANDOFF ---\n{handoff_raw_markdown}\n--- END HANDOFF ---"
    )


async def run_build_agent(
    *,
    handoff_raw_markdown: str,
    workdir: Path,
    permission_rules: dict[str, Any],
    current_task_id: int | None,
    run_short_id: str,
    model: str,
) -> BuildAgentOutput:
    ctx = BuildContext(workdir=workdir, permission_rules=permission_rules)
    tools = ToolRegistry(
        [
            ReadTool(ctx),
            WriteTool(ctx),
            EditTool(ctx),
            BashTool(ctx),
            GrepTool(ctx),
            GlobTool(ctx),
        ]
    )
    system_prompt = BUILD_AGENT_SYSTEM_PROMPT.format(
        workdir=str(workdir),
        current_task_id=current_task_id if current_task_id is not None else "(none)",
        run_short_id=run_short_id,
    )
    config: AgentConfig[BuildAgentOutput] = AgentConfig(
        name="build_agent",
        description="Executes a planner-2 handoff into PRs + debrief.",
        system_prompt=system_prompt,
        llm=from_model(model),
        feedback=NoOpFeedback(),
        tracer=StdoutTracer(color=False),
        tools=tools,
        max_tool_calls=120,
        max_llm_calls=160,
        output_schema=BuildAgentOutput,
    )
    result = await run_agent(config, _build_input(handoff_raw_markdown))
    if result.parsed is None:
        raise RuntimeError(
            f"build agent did not produce a Debrief; output: {result.output[:1000]}"
        )
    return cast(BuildAgentOutput, result.parsed)
