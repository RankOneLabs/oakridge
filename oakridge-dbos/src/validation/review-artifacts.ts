import { z } from "zod";
import { err, ok, type Result } from "../domain/primitives";
import type { SpecAnalysisBody, PlanBody, BuildBriefBody } from "../domain/dev-flow-artifacts";
const strings = z.array(z.string());
const risk = z.object({ description: z.string(), mitigation: z.string() });
const spec = z.object({ summary: z.string(), source_spec_refs: strings,
  findings: z.array(z.object({ id: z.string(), description: z.string(), severity: z.enum(["blocking", "warning", "info"]) })),
  requirements: z.array(z.object({ id: z.string(), description: z.string(), status: z.enum(["implementable", "blocked", "ambiguous"]) })),
  risks: z.array(risk) });
const cohort = z.object({ id: z.string(), repository_key: z.string(), title: z.string(), scope: z.string(), depends_on: strings,
  description: z.string().nullable(), files_in_scope: strings, decisions: strings, acceptance_criteria: strings });
const plan = z.object({ summary: z.string(), cohorts: z.array(cohort), scope: z.object({ in_scope: strings, out_of_scope: strings }),
  acceptance_criteria: strings, risks: z.array(risk) });
const brief = z.object({ cohort_id: z.string(), repository_key: z.string(), title: z.string(), depends_on: strings, goal: z.string(), files_in_scope: strings,
  decisions_made: z.array(z.object({ decision: z.string(), rationale: z.string() })),
  approaches_rejected: z.array(z.object({ approach: z.string(), reason: z.string() })), acceptance_criteria: strings, next_action: z.string() });
export type ReviewArtifactBody = { readonly type: "dev.spec_analysis"; readonly body: SpecAnalysisBody }
  | { readonly type: "dev.plan"; readonly body: PlanBody } | { readonly type: "dev.build_brief"; readonly body: BuildBriefBody };
export interface ReviewArtifactValidationError { readonly operation: "validate_review_artifact"; readonly artifact_type: string; readonly detail: string }
export const parseReviewArtifact = (type: string, body: unknown): Result<ReviewArtifactBody | null, ReviewArtifactValidationError> => {
  const failure = (detail: string) => err({ operation: "validate_review_artifact" as const, artifact_type: type, detail });
  switch (type) {
    case "dev.spec_analysis": { const parsed = spec.safeParse(body); return parsed.success ? ok({ type, body: parsed.data }) : failure(parsed.error.message); }
    case "dev.plan": { const parsed = plan.safeParse(body); return parsed.success ? ok({ type, body: parsed.data }) : failure(parsed.error.message); }
    case "dev.build_brief": { const parsed = brief.safeParse(body); return parsed.success ? ok({ type, body: parsed.data }) : failure(parsed.error.message); }
    default: return ok(null);
  }
};
