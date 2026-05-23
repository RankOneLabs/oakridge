"""Typed Pydantic models mirroring safir's HTTP response payloads.

Sourced from the upstream safir service's zod / db / route shapes
(`safir/src/shared/schema.ts`, `safir/src/db/{plans,atom_edits,threads}.ts`,
`safir/src/api/routes/build-briefs.ts`). The Python names drop TS-side
disambiguators (e.g. `TaskRun` -> `Run`, `RunPhase` -> `Phase`,
`HandoffDocRecord` -> `Handoff`) because Python does not need them.

All models use `extra='ignore'` so the client tolerates new server fields
without lockstep client updates.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class _SafirModel(BaseModel):
    model_config = ConfigDict(extra="ignore")


# --- Tasks ---------------------------------------------------------------

TaskStatus = Literal["backlog", "active", "blocked", "done", "archived"]


class TaskDependency(_SafirModel):
    """Edge in safir's task-dependency graph; `depends_on` is the prerequisite task id."""

    depends_on: int


class Task(_SafirModel):
    id: int
    project_id: str
    parent_id: int | None
    title: str
    notes: str | None
    status: TaskStatus
    priority: int = 0
    deadline: str | None
    blocked_reason: str | None
    default_permission_profile_id: int | None = None
    current_run_id: str | None = None
    created_at: str
    updated_at: str
    completed_at: str | None
    dependencies: list[TaskDependency] = []


# --- Runs / Phases / Handoffs --------------------------------------------

RunStatus = Literal[
    "pending",
    "running",
    "completed",
    "failed",
    "abandoned",
    "awaiting_review",
]
HandoffRole = Literal["phase_output", "run_brief"]


class Run(_SafirModel):
    """Mirrors safir's `TaskRun`."""

    id: str
    task_id: int
    executor: str
    pipeline_id: str | None
    pipeline_version: str | None
    status: RunStatus
    brief: str | None
    result_summary: str | None
    permission_profile_id: int | None
    started_at: str
    finished_at: str | None
    created_by: str | None
    created_by_session: str | None
    phases: list[Phase] = []


class _DecisionMade(_SafirModel):
    decision: str
    rationale: str


class _ApproachRejected(_SafirModel):
    approach: str
    reason: str


class _NotDeliveredItem(_SafirModel):
    item: str
    reason: Literal["deferred", "blocked", "out_of_scope", "failed"]
    notes: str


class _Deviation(_SafirModel):
    instruction: str
    actual: str
    rationale: str


class HandoffParsed(_SafirModel):
    """Parsed sections of a handoff doc. Mirrors safir's `HandoffParsed`."""

    goal: str = ""
    active_subgoals: list[str] = []
    decisions_made: list[_DecisionMade] = []
    approaches_rejected: list[_ApproachRejected] = []
    files_in_scope: list[str] = []
    open_questions: list[str] = []
    next_action: str = ""


class Debrief(_SafirModel):
    delivered_summary: str
    not_delivered: list[_NotDeliveredItem] = []
    deviations: list[_Deviation] = []


class Handoff(_SafirModel):
    """Mirrors safir's `HandoffDocRecord` (with optional embedded debrief)."""

    id: str
    phase_id: str | None
    run_id: str | None
    role: HandoffRole
    schema_version: int
    goal: str | None
    active_subgoals: list[str] | None
    decisions_made: list[_DecisionMade] | None
    approaches_rejected: list[_ApproachRejected] | None
    files_in_scope: list[str] | None
    open_questions: list[str] | None
    next_action: str | None
    raw_markdown: str
    produced_at: str
    debrief: Debrief | None = None


class Phase(_SafirModel):
    """Mirrors safir's `RunPhase`.

    `GET /phases/:id` augments this with the most-recent handoff, so the
    `handoff` field is populated for that endpoint and absent otherwise.
    """

    id: str
    run_id: str
    phase_index: int
    oakridge_session_id: str | None
    external_execution_id: str | None
    parent_phase_id: str | None
    started_at: str
    ended_at: str | None
    end_reason: str | None
    is_terminal: bool
    target_model: str | None = None
    handoff: Handoff | None = None


# --- Permission profiles -------------------------------------------------


class _AutoApproveInputMatch(_SafirModel):
    command_prefix: list[str] | None = None
    path_glob: list[str] | None = None
    input_regex: str | None = None


class _AutoApproveRule(_SafirModel):
    tool: str
    input_match: _AutoApproveInputMatch | None = None


class _DenyPatternInputMatch(_SafirModel):
    command_prefix: list[str] | None = None
    input_regex: str | None = None


class _DenyPattern(_SafirModel):
    tool: str
    input_match: _DenyPatternInputMatch


class _Budgets(_SafirModel):
    max_tool_calls: int | None = None
    max_session_tokens: int | None = None
    max_wall_clock_minutes: int | None = None


class _CompactOverrides(_SafirModel):
    soft_threshold_tokens: int | None = None
    hard_threshold_tokens: int | None = None
    t_quiet_seconds: int | None = None
    t_warm_seconds: int | None = None


class PermissionRules(_SafirModel):
    auto_approve: list[_AutoApproveRule] = []
    always_prompt: list[str] = []
    deny: list[str] = []
    allow_all: bool | None = None
    deny_patterns: list[_DenyPattern] | None = None
    budgets: _Budgets | None = None
    compact_overrides: _CompactOverrides | None = None
    model_override: str | None = None


class PermissionProfile(_SafirModel):
    id: int
    name: str
    description: str | None
    is_seed: bool
    rules: PermissionRules
    created_at: str
    updated_at: str


# --- Plans ---------------------------------------------------------------

ArtifactStatus = Literal["pending_approval", "approved", "rejected", "superseded"]


class PlanCohort(_SafirModel):
    plan_id: str
    cohort_index: int
    title: str
    notes: str
    priority: int
    materialized_task_id: int | None


class CohortDependency(_SafirModel):
    plan_id: str
    from_cohort_index: int
    to_cohort_index: int


class Plan(_SafirModel):
    id: str
    parent_task_id: int
    summary: str | None
    model: str | None
    status: ArtifactStatus
    rejection_reason: str | None
    created_at: str
    updated_at: str
    cohorts: list[PlanCohort]
    dependencies: list[CohortDependency]


# --- Build briefs --------------------------------------------------------


class BuildBrief(Handoff):
    """`Handoff` augmented by safir's `getAugmentedBuildBrief`.

    Adds `task_id`, `status`, `rejection_reason`, and
    `predecessor_build_brief_id` on top of the underlying handoff record.
    """

    task_id: int | None
    status: ArtifactStatus
    rejection_reason: str | None
    predecessor_build_brief_id: str | None


# --- Atom edits ----------------------------------------------------------

# Atom maps come back as a flat object on the wire; expose as an alias
# rather than a BaseModel so consumers index naturally.
type AtomMap = dict[str, str]


class AtomEdit(_SafirModel):
    """Mirrors safir's `AtomEditRecord`."""

    id: str
    target_type: str
    target_id: str
    anchor: str
    prev_value: str | None
    new_value: str
    edited_by: str
    thread_id: str | None
    created_at: str


# --- Threads -------------------------------------------------------------

ThreadStatus = Literal["open", "resolved"]


class ThreadMessage(_SafirModel):
    """Mirrors safir's `ThreadMessageRecord`."""

    id: str
    thread_id: str
    author: str
    body: str
    related_edit_id: str | None
    created_at: str


class Thread(_SafirModel):
    """Mirrors safir's `ThreadRecord`."""

    id: str
    target_type: str
    target_id: str
    anchor: str | None
    status: ThreadStatus
    agent_responding: int
    resolved_at: str | None
    created_at: str
    messages: list[ThreadMessage] = []


# --- Agent response ack --------------------------------------------------


class AgentResponseAck(_SafirModel):
    """Body returned by `POST /threads/:id/agent-response`."""

    ok: bool
