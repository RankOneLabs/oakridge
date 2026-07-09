import { z } from "zod";

// Mirrors the stages table's name column (see migrations/020_rename_review_to_assess.sql).
// plans.current_session_stage has no DB CHECK (migration 010 comment); Zod is
// authoritative. Surviving stages: spec_analyzer, plan_writer, brief_writer, assessor, build.
export const SessionStageSchema = z.enum(["spec_analyzer", "plan_writer", "brief_writer", "assessor", "build"]);
export type SessionStage = z.infer<typeof SessionStageSchema>;

export const SpecInternalStatusSchema = z.enum(["analyzing", "discrepancies", "review", "approved"]);
export type SpecInternalStatus = z.infer<typeof SpecInternalStatusSchema>;

export const SpecSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  current_session_ref: z.string().nullable(),
  current_session_stage: SessionStageSchema.nullable(),
  submitted_notes: z.string().nullable(),
  final_notes: z.string().nullable(),
  internal_status: SpecInternalStatusSchema,
  created_at: z.string(),
});
export type Spec = z.infer<typeof SpecSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  spec_id: z.string(),
  status: z.enum(["draft", "pending_approval", "approved", "rejected", "superseded"]),
  predecessor_plan_id: z.string().nullable(),
  model: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  current_session_ref: z.string().nullable(),
  current_session_stage: SessionStageSchema.nullable(),
  created_at: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const CohortStatusSchema = z.enum(["waiting", "planned", "briefing", "brief_review", "building", "ready_to_build", "awaiting_merge", "done", "blocked"]);
export type CohortStatus = z.infer<typeof CohortStatusSchema>;

export const CohortSchema = z.object({
  id: z.string(),
  plan_id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  position: z.number().int(),
  status: CohortStatusSchema,
  pre_block_status: z.enum(["waiting", "planned", "briefing", "brief_review", "building", "ready_to_build", "awaiting_merge", "done"]).nullable(),
  current_session_ref: z.string().nullable(),
  current_session_stage: SessionStageSchema.nullable(),
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

export const BriefDeviationSchema = z.object({
  from: z.string(),
  actual: z.string(),
  downstream_impact: z.string(),
});

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
  pr_url: z.string().url().nullable(),
  rejection_reason: z.string().nullable(),
  deviations: z.array(BriefDeviationSchema).nullable(),
  created_at: z.string(),
});
export type Brief = z.infer<typeof BriefSchema>;

export const DeviationsCatalogEntrySchema = z.object({
  cohort_id: z.string(),
  cohort_title: z.string(),
  deviations: z.array(BriefDeviationSchema),
});
export type DeviationsCatalogEntry = z.infer<typeof DeviationsCatalogEntrySchema>;

export const AssessmentSchema = z.object({
  id: z.string(),
  plan_id: z.string(),
  summary: z.string(),
  deviations_catalog: z.array(DeviationsCatalogEntrySchema),
  gap_analysis: z.string(),
  fix_plan: z.string(),
  model: z.string().nullable(),
  created_at: z.string(),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const EpicStatusSchema = z.enum(["pending", "active", "complete", "archived"]);
export type EpicStatus = z.infer<typeof EpicStatusSchema>;

export const EpicStageSchema = z.enum(["spec", "plan", "build", "assess"]);
export type EpicStage = z.infer<typeof EpicStageSchema>;

export const AgentRuntimeChoiceSchema = z.enum(["claude-code", "codex"]);
export type AgentRuntimeChoice = z.infer<typeof AgentRuntimeChoiceSchema>;

export const EpicModelSelectionSchema = z.object({
  runtime: AgentRuntimeChoiceSchema,
  model: z.string().min(1),
  // Reasoning/effort level; null (or absent) = no override / runtime default.
  effort: z.string().min(1).nullish(),
});
export type EpicModelSelection = z.infer<typeof EpicModelSelectionSchema>;

export const EpicSchema = z.object({
  id: z.string(),
  spec_id: z.string(),
  project_id: z.string(),
  title: z.string(),
  status: EpicStatusSchema,
  current_stage: EpicStageSchema,
  planner_model_selection: EpicModelSelectionSchema,
  worker_model_selection: EpicModelSelectionSchema,
  created_at: z.string(),
});
export type Epic = z.infer<typeof EpicSchema>;

export const SpecDiscrepancyStatusSchema = z.enum(["open", "resolved", "waived"]);
export type SpecDiscrepancyStatus = z.infer<typeof SpecDiscrepancyStatusSchema>;

export const SpecDiscrepancySchema = z.object({
  id: z.string(),
  spec_id: z.string(),
  spec_assumption: z.string(),
  code_reality: z.string(),
  resolution: z.string().nullable(),
  status: SpecDiscrepancyStatusSchema,
  created_at: z.string(),
});
export type SpecDiscrepancy = z.infer<typeof SpecDiscrepancySchema>;
