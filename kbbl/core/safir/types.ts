// Mirror of safir's src/shared/schema.ts as of 2026-05-14. Copied verbatim
// rather than imported so kbbl is buildable without the safir package on
// disk and so a safir-side schema change can't silently shift wire shapes
// underneath us — a deliberate divergence becomes a visible test failure
// in the PR-B in-process integration tests.
// Append-only enum additions land here; see safir migration 009 for awaiting_review.

import { z } from "zod";

export const RunStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "abandoned",
  "awaiting_review",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const Executor = z.string().min(1);
export type Executor = z.infer<typeof Executor>;

export const HandoffRole = z.enum(["phase_output", "run_brief"]);
export type HandoffRole = z.infer<typeof HandoffRole>;

export const TaskRun = z.object({
  id: z.string(),
  task_id: z.number(),
  executor: Executor,
  pipeline_id: z.string().nullable(),
  pipeline_version: z.string().nullable(),
  status: RunStatus,
  brief: z.string().nullable(),
  result_summary: z.string().nullable(),
  permission_profile_id: z.number().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  created_by: z.string().nullable(),
  created_by_session: z.string().nullable(),
});
export type TaskRun = z.infer<typeof TaskRun>;

export const CreateTaskRun = z.object({
  executor: Executor,
  status: RunStatus.optional().default("pending"),
  brief: z.string().nullable().optional(),
  pipeline_id: z.string().nullable().optional(),
  pipeline_version: z.string().nullable().optional(),
  permission_profile_id: z.number().nullable().optional(),
  created_by: z.string().nullable().optional(),
  created_by_session: z.string().nullable().optional(),
});
export type CreateTaskRun = z.infer<typeof CreateTaskRun>;

export const UpdateTaskRun = z.object({
  status: RunStatus.optional(),
  brief: z.string().nullable().optional(),
  result_summary: z.string().nullable().optional(),
  pipeline_id: z.string().nullable().optional(),
  pipeline_version: z.string().nullable().optional(),
  permission_profile_id: z.number().nullable().optional(),
  executor: Executor.optional(),
});
export type UpdateTaskRun = z.infer<typeof UpdateTaskRun>;

export const RunPhase = z.object({
  id: z.string(),
  run_id: z.string(),
  phase_index: z.number(),
  oakridge_session_id: z.string().nullable(),
  external_execution_id: z.string().nullable(),
  parent_phase_id: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  end_reason: z.string().nullable(),
  is_terminal: z.boolean(),
  target_model: z.string().nullable().optional(),
});
export type RunPhase = z.infer<typeof RunPhase>;

export const CreateRunPhase = z.object({
  oakridge_session_id: z.string().nullable().optional(),
  external_execution_id: z.string().nullable().optional(),
  parent_phase_id: z.string().nullable().optional(),
  target_model: z.string().nullable().optional(),
});
export type CreateRunPhase = z.infer<typeof CreateRunPhase>;

export const UpdateRunPhase = z.object({
  oakridge_session_id: z.string().nullable().optional(),
  external_execution_id: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional(),
  end_reason: z.string().nullable().optional(),
  is_terminal: z.boolean().optional(),
  target_model: z.string().nullable().optional(),
});
export type UpdateRunPhase = z.infer<typeof UpdateRunPhase>;

export const Debrief = z.object({
  delivered_summary: z.string(),
  not_delivered: z.array(z.object({
    item: z.string(),
    reason: z.enum(["deferred", "blocked", "out_of_scope", "failed"]),
    notes: z.string(),
  })).default([]),
  deviations: z.array(z.object({
    instruction: z.string(),
    actual: z.string(),
    rationale: z.string(),
  })).default([]),
});
export type Debrief = z.infer<typeof Debrief>;

export const SubmitDebrief = z.object({ debrief: Debrief }).strict();
export type SubmitDebrief = z.infer<typeof SubmitDebrief>;

export const HandoffParsed = z.object({
  goal: z.string().default(""),
  active_subgoals: z.array(z.string()).default([]),
  decisions_made: z
    .array(z.object({ decision: z.string(), rationale: z.string() }))
    .default([]),
  approaches_rejected: z
    .array(z.object({ approach: z.string(), reason: z.string() }))
    .default([]),
  files_in_scope: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  next_action: z.string().default(""),
});
export type HandoffParsed = z.infer<typeof HandoffParsed>;

export const HandoffDocRecord = z.object({
  id: z.string(),
  phase_id: z.string().nullable(),
  run_id: z.string().nullable(),
  role: HandoffRole,
  schema_version: z.number(),
  goal: z.string().nullable(),
  active_subgoals: z.array(z.string()).nullable(),
  decisions_made: z
    .array(z.object({ decision: z.string(), rationale: z.string() }))
    .nullable(),
  approaches_rejected: z
    .array(z.object({ approach: z.string(), reason: z.string() }))
    .nullable(),
  files_in_scope: z.array(z.string()).nullable(),
  open_questions: z.array(z.string()).nullable(),
  next_action: z.string().nullable(),
  raw_markdown: z.string(),
  produced_at: z.string(),
  debrief: Debrief.nullable().optional(),
});
export type HandoffDocRecord = z.infer<typeof HandoffDocRecord>;

export const SubmitHandoff = z.object({
  raw_markdown: z.string().min(1),
  parsed: HandoffParsed.partial().optional(),
});
export type SubmitHandoff = z.infer<typeof SubmitHandoff>;

// Minimal Task shape (only what kbbl reads from /tasks/:id). safir's full
// shape carries breadcrumbs, depth, etc. that kbbl doesn't consume; keeping
// this narrow makes Zod failures point at exactly the field kbbl cares
// about instead of unrelated breadcrumb drift.
export const Task = z.object({
  id: z.number(),
  project_id: z.string(),
  parent_id: z.number().nullable(),
  title: z.string(),
  status: z.string(),
  default_permission_profile_id: z.number().nullable().optional(),
});
export type Task = z.infer<typeof Task>;

// Mirror of safir's PermissionRules as of 2026-05-11. See cross-repo
// schema duplication note in kbbl/core/safir/types.ts file header.
export const PermissionRules = z.object({
  auto_approve: z.array(z.object({
    tool: z.string(),
    input_match: z.object({
      command_prefix: z.array(z.string()).optional(),
      path_glob: z.array(z.string()).optional(),
      input_regex: z.string().max(500).optional(),
    }).optional(),
  })).default([]),
  always_prompt: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  allow_all: z.boolean().optional(),
  deny_patterns: z.array(z.object({
    tool: z.string(),
    input_match: z.object({
      command_prefix: z.array(z.string()).optional(),
      input_regex: z.string().max(500).optional(),
    }),
  })).optional(),
  budgets: z.object({
    max_tool_calls: z.number().optional(),
    max_session_tokens: z.number().optional(),
    max_wall_clock_minutes: z.number().optional(),
  }).optional(),
  compact_overrides: z.object({
    soft_threshold_tokens: z.number().optional(),
    hard_threshold_tokens: z.number().optional(),
  }).optional(),
  model_override: z.string().optional(),
}).strict();
export type PermissionRules = z.infer<typeof PermissionRules>;

export const PermissionProfile = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  is_seed: z.boolean(),
  rules: PermissionRules,
  created_at: z.string(),
  updated_at: z.string(),
});
export type PermissionProfile = z.infer<typeof PermissionProfile>;

export const CreatePermissionProfile = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  is_seed: z.boolean().optional(),
  rules: PermissionRules,
});
export type CreatePermissionProfile = z.infer<typeof CreatePermissionProfile>;

export const UpdatePermissionProfile = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  rules: PermissionRules.optional(),
});
export type UpdatePermissionProfile = z.infer<typeof UpdatePermissionProfile>;

// --- Artifact review system (added 2026-05-13) ---

export const ArtifactStatus = z.enum([
  "pending_approval",
  "approved",
  "rejected",
  "superseded",
]);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

export const PlanCohort = z.object({
  plan_id: z.string(),
  cohort_index: z.number().int(),
  title: z.string(),
  notes: z.string(),
  priority: z.number().int(),
  materialized_task_id: z.number().nullable(),
});
export type PlanCohort = z.infer<typeof PlanCohort>;

export const CohortDependency = z.object({
  plan_id: z.string(),
  from_cohort_index: z.number().int(),
  to_cohort_index: z.number().int(),
});
export type CohortDependency = z.infer<typeof CohortDependency>;

export const Plan = z.object({
  id: z.string(),
  parent_task_id: z.number(),
  summary: z.string().nullable(),
  model: z.string().nullable(),
  status: ArtifactStatus,
  rejection_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  cohorts: z.array(PlanCohort),
  dependencies: z.array(CohortDependency),
});
export type Plan = z.infer<typeof Plan>;

export const AtomEdit = z.object({
  id: z.string(),
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
  anchor: z.string(),
  prev_value: z.string().nullable(),
  new_value: z.string(),
  edited_by: z.string(),
  thread_id: z.string().nullable(),
  created_at: z.string(),
});
export type AtomEdit = z.infer<typeof AtomEdit>;

export const AtomEditConflict = z.object({
  error: z.literal("stale_prev_value"),
  current_value: z.string().nullable(),
  latest_edit_id: z.string(),
  edited_by: z.string(),
  created_at: z.string(),
});
export type AtomEditConflict = z.infer<typeof AtomEditConflict>;

export const ThreadMessage = z.object({
  id: z.string(),
  thread_id: z.string(),
  author: z.string(),
  body: z.string(),
  related_edit_id: z.string().nullable(),
  created_at: z.string(),
});
export type ThreadMessage = z.infer<typeof ThreadMessage>;

export const CommentThread = z.object({
  id: z.string(),
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
  anchor: z.string().nullable(),
  status: z.enum(["open", "resolved"]),
  agent_responding: z.number().int(),
  resolved_at: z.string().nullable(),
  created_at: z.string(),
  messages: z.array(ThreadMessage),
});
export type CommentThread = z.infer<typeof CommentThread>;

export const BuildBrief = z.object({
  id: z.string(),
  phase_id: z.string().nullable(),
  run_id: z.string().nullable(),
  role: z.enum(["phase_output", "run_brief"]),
  schema_version: z.number(),
  status: ArtifactStatus,
  rejection_reason: z.string().nullable(),
  predecessor_build_brief_id: z.string().nullable(),
  goal: z.string().nullable(),
  active_subgoals: z.array(z.string()).nullable(),
  decisions_made: z.array(z.object({ decision: z.string(), rationale: z.string() })).nullable(),
  approaches_rejected: z.array(z.object({ approach: z.string(), reason: z.string() })).nullable(),
  files_in_scope: z.array(z.string()).nullable(),
  open_questions: z.array(z.string()).nullable(),
  next_action: z.string().nullable(),
  raw_markdown: z.string(),
  produced_at: z.string(),
  debrief: Debrief.nullable().optional(),
});
export type BuildBrief = z.infer<typeof BuildBrief>;

// Webhook payload shapes for artifact-review events.
export const PlanCreatedPayload = z.object({
  plan_id: z.string(),
  parent_task_id: z.number(),
});
export type PlanCreatedPayload = z.infer<typeof PlanCreatedPayload>;

export const BuildBriefSubmittedPayload = z.object({
  build_brief_id: z.string(),
  phase_id: z.string(),
  run_id: z.string().nullable(),
});
export type BuildBriefSubmittedPayload = z.infer<typeof BuildBriefSubmittedPayload>;

export const AtomEditAppliedPayload = z.object({
  edit_id: z.string(),
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
  anchor: z.string(),
  thread_id: z.string().nullable(),
});
export type AtomEditAppliedPayload = z.infer<typeof AtomEditAppliedPayload>;

export const ArtifactStatusChangedPayload = z.object({
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
  status: ArtifactStatus,
  rejection_reason: z.string().nullable().optional(),
});
export type ArtifactStatusChangedPayload = z.infer<typeof ArtifactStatusChangedPayload>;

export const ArtifactReopenedPayload = z.object({
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
});
export type ArtifactReopenedPayload = z.infer<typeof ArtifactReopenedPayload>;

export const CommentThreadCreatedPayload = z.object({
  thread_id: z.string(),
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
  anchor: z.string().nullable(),
});
export type CommentThreadCreatedPayload = z.infer<typeof CommentThreadCreatedPayload>;

export const ThreadMessageAddedPayload = z.object({
  thread_id: z.string(),
  message_id: z.string().nullable(),
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
});
export type ThreadMessageAddedPayload = z.infer<typeof ThreadMessageAddedPayload>;

export const ThreadStatusChangedPayload = z.object({
  thread_id: z.string(),
  status: z.enum(["open", "resolved"]),
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
});
export type ThreadStatusChangedPayload = z.infer<typeof ThreadStatusChangedPayload>;

export const ThreadAgentResponseStartedPayload = z.object({
  thread_id: z.string(),
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
  anchor: z.string().nullable(),
});
export type ThreadAgentResponseStartedPayload = z.infer<typeof ThreadAgentResponseStartedPayload>;

export const ThreadAgentResponseCompletedPayload = z.object({
  thread_id: z.string(),
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
  anchor: z.string().nullable(),
  reply_message_id: z.string().nullable().optional(),
});
export type ThreadAgentResponseCompletedPayload = z.infer<typeof ThreadAgentResponseCompletedPayload>;

export const ThreadAgentResponseFailedPayload = z.object({
  thread_id: z.string(),
  target_type: z.enum(["plan", "build_brief"]),
  target_id: z.string(),
  anchor: z.string().nullable(),
  error: z.string().nullable().optional(),
  reply_message_id: z.string().nullable().optional(),
});
export type ThreadAgentResponseFailedPayload = z.infer<typeof ThreadAgentResponseFailedPayload>;
