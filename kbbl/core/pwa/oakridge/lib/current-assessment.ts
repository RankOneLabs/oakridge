import { z } from "zod";
import type { OperatorAssessmentBody, OperatorItemAssessment, OperatorAdditionalFinding, OperatorAssessmentAction } from "../operator-contracts/domain/assessment";
import { parseCurrent } from "./current-contract";
import type { SubnavSection } from "./artifact-subnav";

/** The named domain model is generated from the backend's development.yaml mirror. */
export type CurrentAssessment = OperatorAssessmentBody;
const evidence = z.object({ kind: z.enum(["file", "test", "output"]), ref: z.string(), detail: z.string().nullish() });
const identifier = z.string().min(1);
export const currentAssessmentSchema: z.ZodType<CurrentAssessment> = z.object({
  head_sha: z.string(), verdict: z.enum(["pass", "pass_with_notes", "fail"]),
  item_assessments: z.array(z.object({ subject: z.object({ kind: z.enum(["build_item", "requirement"]), id: identifier }),
    status: z.enum(["met", "partial", "not_met"]), observation: z.string(), evidence: z.array(evidence) })),
  additional_findings: z.array(z.object({ id: identifier, severity: z.enum(["blocking", "warning", "info"]), observation: z.string(), related_build_item_ids: z.array(identifier), evidence: z.array(evidence) })),
  next_actions: z.array(z.object({ id: z.string().uuid(), audience: z.enum(["builder", "operator"]), source: z.object({ kind: z.enum(["item_assessment", "additional_finding"]), id: identifier }), text: z.string() })),
  test_evidence: z.object({ passed: z.number().int(), failed: z.number().int(), output: z.string().nullish(), summary: z.string().nullish(), cargo_test_output: z.string().nullish() }),
});
export const parseCurrentAssessment = (body: unknown) => parseCurrent(currentAssessmentSchema, body, "parse_current_assessment");
export interface AssessmentStatusGroup { readonly status: OperatorItemAssessment["status"]; readonly count: number; readonly items: readonly OperatorItemAssessment[] }
export type AssessmentStatusFilter = "all" | "needs_attention" | OperatorItemAssessment["status"];
export function selectItemAssessmentGroups(assessment: CurrentAssessment, filter: AssessmentStatusFilter = "all"): readonly AssessmentStatusGroup[] {
  return (["not_met", "partial", "met"] as const).filter(status => filter === "all" || (filter === "needs_attention" ? status !== "met" : filter === status))
    .map(status => ({ status, items: assessment.item_assessments.filter(item => item.status === status), count: assessment.item_assessments.filter(item => item.status === status).length }));
}
export interface AssessmentItemLabel { readonly id: string; readonly label: string }
export interface AttributedFinding { readonly finding: OperatorAdditionalFinding; readonly labels: readonly AssessmentItemLabel[]; readonly is_unattributed: boolean }
export function selectAdditionalFindings(assessment: CurrentAssessment, labels: readonly AssessmentItemLabel[] = []): readonly AttributedFinding[] {
  return assessment.additional_findings.map(finding => ({ finding, is_unattributed: finding.related_build_item_ids.length === 0,
    labels: finding.related_build_item_ids.map(id => ({ id, label: labels.find(label => label.id === id)?.label ?? id })) }));
}
export interface AssessmentActionLists { readonly builder: readonly OperatorAssessmentAction[]; readonly operator: readonly OperatorAssessmentAction[] }
export const selectAssessmentActions = (assessment: CurrentAssessment): AssessmentActionLists => ({
  builder: assessment.next_actions.filter(action => action.audience === "builder"), operator: assessment.next_actions.filter(action => action.audience === "operator"),
});
export interface DerivedAssessmentVerdict { readonly verdict: CurrentAssessment["verdict"]; readonly has_mismatch: boolean }
export function selectDerivedVerdict(assessment: CurrentAssessment): DerivedAssessmentVerdict {
  const verdict = assessment.item_assessments.some(item => item.status !== "met") || assessment.additional_findings.some(finding => finding.severity === "blocking") ? "fail"
    : assessment.additional_findings.some(finding => finding.severity === "warning") ? "pass_with_notes" : "pass";
  return { verdict, has_mismatch: verdict !== assessment.verdict };
}

export type AssessmentSection = "items" | "findings" | "actions" | "tests";
/** The current assessment viewer's subnav: item assessments, additional findings, actions, then test evidence. */
export const selectAssessmentSections = (assessment: CurrentAssessment): readonly SubnavSection<AssessmentSection>[] => [
  { value: "items", label: "Items", count: assessment.item_assessments.length },
  { value: "findings", label: "Findings", count: assessment.additional_findings.length },
  { value: "actions", label: "Actions", count: assessment.next_actions.length },
  { value: "tests", label: "Tests", count: null },
];
