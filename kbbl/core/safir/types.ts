// Mirror of safir's src/shared/schema.ts as of 2026-05-09. Copied verbatim
// rather than imported so kbbl is buildable without the safir package on
// disk and so a safir-side schema change can't silently shift wire shapes
// underneath us — a deliberate divergence becomes a visible test failure
// in the PR-B in-process integration tests.

import { z } from "zod";

export const RunStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "abandoned",
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
});
export type RunPhase = z.infer<typeof RunPhase>;

export const CreateRunPhase = z.object({
  oakridge_session_id: z.string().nullable().optional(),
  external_execution_id: z.string().nullable().optional(),
  parent_phase_id: z.string().nullable().optional(),
});
export type CreateRunPhase = z.infer<typeof CreateRunPhase>;

export const UpdateRunPhase = z.object({
  oakridge_session_id: z.string().nullable().optional(),
  external_execution_id: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional(),
  end_reason: z.string().nullable().optional(),
  is_terminal: z.boolean().optional(),
});
export type UpdateRunPhase = z.infer<typeof UpdateRunPhase>;

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

// Mirror of safir's PermissionRules as of 2026-05-10. See cross-repo
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
    t_quiet_seconds: z.number().optional(),
    t_warm_seconds: z.number().optional(),
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
