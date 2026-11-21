import type { Result } from "./primitives";

/** Mirrors assessment_body and its dependencies, which every workflow shares except
 * assessment_subject's kinds: each workflow declares what its assessor grades. */
export interface AssessmentEvidence { readonly kind: "file" | "test" | "output"; readonly ref: string; readonly detail?: string | null }
export interface AssessmentSubject { readonly kind: string; readonly id: string }
export interface ItemAssessment {
  readonly subject: AssessmentSubject; readonly status: "met" | "partial" | "not_met";
  readonly observation: string; readonly evidence: readonly AssessmentEvidence[];
}
export interface AdditionalFinding {
  readonly id: string; readonly severity: "blocking" | "warning" | "info"; readonly observation: string;
  readonly related_build_item_ids: readonly string[]; readonly evidence: readonly AssessmentEvidence[];
}
export interface ActionSource { readonly kind: "item_assessment" | "additional_finding"; readonly id: string }
export interface AssessmentAction { readonly id: string; readonly audience: "rework" | "operator"; readonly source: ActionSource; readonly text: string }
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
const fields = (value: unknown): value is { readonly [key: string]: unknown } => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const optionalText = (value: unknown): value is string | null | undefined => value == null || text(value);
const list = <T>(value: unknown, predicate: (entry: unknown) => entry is T): value is readonly T[] => Array.isArray(value) && value.every(predicate);
const evidence = (value: unknown): value is AssessmentEvidence => fields(value) && ["file", "test", "output"].includes(String(value.kind)) && text(value.ref) && optionalText(value.detail);
export const isActionSource = (value: unknown): value is ActionSource => fields(value) && (value.kind === "item_assessment" || value.kind === "additional_finding") && text(value.id);
const item = (value: unknown): value is ItemAssessment => fields(value) && fields(value.subject) && text(value.subject.kind) && value.subject.kind !== ""
  && text(value.subject.id) && ["met", "partial", "not_met"].includes(String(value.status)) && text(value.observation) && list(value.evidence, evidence);
const finding = (value: unknown): value is AdditionalFinding => fields(value) && text(value.id) && ["blocking", "warning", "info"].includes(String(value.severity))
  && text(value.observation) && list(value.related_build_item_ids, text) && list(value.evidence, evidence);
const action = (value: unknown): value is AssessmentAction => fields(value) && text(value.id) && (value.audience === "rework" || value.audience === "operator") && isActionSource(value.source) && text(value.text);
const tests = (value: unknown): value is AssessmentTestEvidence => fields(value) && Number.isSafeInteger(value.passed) && Number.isSafeInteger(value.failed)
  && optionalText(value.output) && optionalText(value.summary) && optionalText(value.cargo_test_output);
export function parseAssessmentBody(body: unknown): Result<AssessmentBody, AssessmentReadError> {
  if (!fields(body) || !text(body.head_sha) || !list(body.item_assessments, item) || !list(body.additional_findings, finding) || !list(body.next_actions, action)
      || !tests(body.test_evidence) || !["pass", "pass_with_notes", "fail"].includes(String(body.verdict))) return { ok: false,
    error: { operation: "parse_current_assessment", detail: "body does not match assessment_body" } };
  return { ok: true, value: body as unknown as AssessmentBody };
}
