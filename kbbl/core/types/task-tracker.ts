import { z } from "zod";

export const SpecSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  status: z.enum(["draft", "plan_review", "planning_done", "done", "archived"]),
  current_session_ref: z.string().nullable(),
  created_at: z.string(),
});
export type Spec = z.infer<typeof SpecSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  spec_id: z.string(),
  status: z.enum(["pending_approval", "approved", "rejected", "superseded"]),
  predecessor_plan_id: z.string().nullable(),
  model: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  created_at: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const CohortSchema = z.object({
  id: z.string(),
  plan_id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  position: z.number().int(),
  status: z.enum(["waiting", "planned", "briefing", "brief_review", "building", "done", "blocked"]),
  pre_block_status: z.enum(["waiting", "planned", "briefing", "brief_review", "building", "done"]).nullable(),
  current_session_ref: z.string().nullable(),
  created_at: z.string(),
});
export type Cohort = z.infer<typeof CohortSchema>;

export const CohortDependencySchema = z.object({
  id: z.string(),
  from_cohort_id: z.string(),
  to_cohort_id: z.string(),
});
export type CohortDependency = z.infer<typeof CohortDependencySchema>;

export const BriefPayloadSchema = z.object({
  files_in_scope: z.array(z.string()),
  decisions_made: z.array(z.object({ decision: z.string(), rationale: z.string() })),
  approaches_rejected: z.array(z.object({ approach: z.string(), reason: z.string() })),
});
export type BriefPayload = z.infer<typeof BriefPayloadSchema>;

export const BriefSchema = z.object({
  id: z.string(),
  cohort_id: z.string(),
  status: z.enum(["pending_approval", "approved", "rejected", "superseded"]),
  predecessor_brief_id: z.string().nullable(),
  model: z.string().nullable(),
  goal: z.string(),
  files_in_scope: z.array(z.string()),
  decisions_made: z.array(z.object({ decision: z.string(), rationale: z.string() })),
  approaches_rejected: z.array(z.object({ approach: z.string(), reason: z.string() })),
  next_action: z.string(),
  debrief: z.string().nullable(),
  pr_url: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  created_at: z.string(),
});
export type Brief = z.infer<typeof BriefSchema>;
