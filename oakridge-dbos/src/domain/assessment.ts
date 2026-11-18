import { z } from "zod";
import type { Result } from "./primitives";

/** Mirrors assessment_body and its dependencies in workflow-config/development.yaml §8. */
export interface AssessmentEvidence { readonly kind: "file" | "test" | "output"; readonly ref: string; readonly detail?: string | null }
export interface AssessmentSubject { readonly kind: "build_item" | "requirement"; readonly id: string }
export interface ItemAssessment {
  readonly subject: AssessmentSubject; readonly status: "met" | "partial" | "not_met";
  readonly observation: string; readonly evidence: readonly AssessmentEvidence[];
}
export interface AdditionalFinding {
  readonly id: string; readonly severity: "blocking" | "warning" | "info"; readonly observation: string;
  readonly related_build_item_ids: readonly string[]; readonly evidence: readonly AssessmentEvidence[];
}
export interface ActionSource { readonly kind: "item_assessment" | "additional_finding"; readonly id: string }
export interface AssessmentAction { readonly id: string; readonly audience: "builder" | "operator"; readonly source: ActionSource; readonly text: string }
export interface AssessmentTestEvidence {
  readonly passed: number; readonly failed: number; readonly output?: string | null;
  readonly summary?: string | null; readonly cargo_test_output?: string | null;
}
export interface AssessmentBody {
  readonly head_sha: string; readonly item_assessments: readonly ItemAssessment[];
  readonly additional_findings: readonly AdditionalFinding[]; readonly next_actions: readonly AssessmentAction[];
  readonly test_evidence: AssessmentTestEvidence; readonly verdict: "pass" | "pass_with_notes" | "fail";
}
export interface AssessmentReadError { readonly operation: "parse_current_assessment"; readonly detail: string }
const evidence = z.object({ kind: z.enum(["file", "test", "output"]), ref: z.string(), detail: z.string().nullish() });
export const actionSourceSchema = z.object({ kind: z.enum(["item_assessment", "additional_finding"]), id: z.string() });
export const assessmentSchema: z.ZodType<AssessmentBody> = z.object({
  head_sha: z.string(),
  item_assessments: z.array(z.object({ subject: z.object({ kind: z.enum(["build_item", "requirement"]), id: z.string() }),
    status: z.enum(["met", "partial", "not_met"]), observation: z.string(), evidence: z.array(evidence) })),
  additional_findings: z.array(z.object({ id: z.string(), severity: z.enum(["blocking", "warning", "info"]), observation: z.string(),
    related_build_item_ids: z.array(z.string()), evidence: z.array(evidence) })),
  next_actions: z.array(z.object({ id: z.string().uuid(), audience: z.enum(["builder", "operator"]), source: actionSourceSchema, text: z.string() })),
  test_evidence: z.object({ passed: z.number().int(), failed: z.number().int(), output: z.string().nullish(), summary: z.string().nullish(), cargo_test_output: z.string().nullish() }),
  verdict: z.enum(["pass", "pass_with_notes", "fail"]),
});
export function parseAssessmentBody(body: unknown): Result<AssessmentBody, AssessmentReadError> {
  const parsed = assessmentSchema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: { operation: "parse_current_assessment", detail: parsed.error.message } };
}
