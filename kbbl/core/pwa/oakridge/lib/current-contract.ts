import { z } from "zod";
import type { Result } from "../../lib/result";

// Field-for-field readers for workflow-config/development.yaml, schemas § analysis..brief.
const identifier = z.string().refine((value) => value.length > 0 && [...value].length <= 100 && !/[\p{Cc}/\\]/u.test(value), "expected an ident");
const ident = identifier.brand<"RequirementId">();
const findingId = identifier.brand<"FindingId">();
const cohortId = identifier.brand<"CohortId">();
const buildItemId = identifier.brand<"BuildItemId">();
const optional = <T extends z.ZodType>(schema: T) => schema.nullish();
export const resolutionSchema = z.object({
  kind: z.enum(["spec_update", "operator_decision", "implementation_note"]), text: z.string(),
  question: optional(z.string()), alternatives: optional(z.array(z.object({ option: z.string(), consequence: z.string() }))), chosen: optional(z.string()),
});
export const findingSchema = z.object({ id: findingId, severity: z.enum(["blocking", "warning", "info"]), observation: z.string(),
  evidence: z.array(z.object({ kind: z.enum(["file", "search", "test", "output"]), ref: z.string(), detail: z.string() })),
  expected_change_locations: z.array(z.object({ path: z.string(), symbol: optional(z.string()) })), resolution: optional(resolutionSchema),
});
export const analysisSchema = z.object({ requirements: z.array(z.object({ id: ident, text: z.string(), source_refs: z.array(z.string()), findings: z.array(findingSchema) })) });
export const requirementSchema = z.object({ id: ident, text: z.string(), acceptance_conditions: z.array(z.string()), source_refs: z.array(z.string()), analysis_finding_ids: z.array(findingId) });
export const specSchema = z.object({ objective: z.string(), requirements: z.array(requirementSchema), non_goals: z.array(z.string()) });
export const cohortSchema = z.object({ id: cohortId, repository_key: identifier.brand<"RepositoryKey">(), title: z.string(), scope: z.string(),
  allocations: z.array(z.object({ requirement_id: ident, contribution: z.string() })), depends_on: z.array(cohortId), rationale: z.string() });
export const planSchema = z.object({ cohorts: z.array(cohortSchema) });
export const briefSchema = z.object({ cohort_id: cohortId, repository_key: identifier.brand<"RepositoryKey">(), depends_on: z.array(cohortId), files_in_scope: z.array(z.string()),
  build_items: z.array(z.object({ id: buildItemId, requirement_ids: z.array(ident), instructions: z.string(), verification: z.array(z.string()) })),
  technical_decisions: z.array(z.object({ id: identifier.brand<"TechnicalDecisionId">(), build_item_ids: z.array(buildItemId), decision: z.string(), rationale: z.string() })),
});
export const assignmentSchema = z.object({ cohort: cohortSchema, requirements: z.array(requirementSchema) });
export type RequirementId = z.infer<typeof ident>;
export type CurrentFinding = z.infer<typeof findingSchema>;
export type CurrentAnalysis = z.infer<typeof analysisSchema>;
export type CanonicalRequirement = z.infer<typeof requirementSchema>;
export type CanonicalSpec = z.infer<typeof specSchema>;
export type CurrentCohort = z.infer<typeof cohortSchema>;
export type CurrentPlan = z.infer<typeof planSchema>;
export type CurrentBrief = z.infer<typeof briefSchema>;
export type ResolvedAssignment = z.infer<typeof assignmentSchema>;
export interface CurrentParseError { readonly operation: string; readonly detail: string }
export function parseCurrent<T>(schema: z.ZodType<T>, body: unknown, operation: string): Result<T, CurrentParseError> {
  const result = schema.safeParse(body);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: { operation, detail: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") } };
}
export const parseCurrentAnalysis = (body: unknown) => parseCurrent(analysisSchema, body, "parse_current_analysis");
export const parseCanonicalSpec = (body: unknown) => parseCurrent(specSchema, body, "parse_canonical_spec");
export const parseCurrentPlan = (body: unknown) => parseCurrent(planSchema, body, "parse_current_plan");
export const parseCurrentBrief = (body: unknown) => parseCurrent(briefSchema, body, "parse_current_brief");
