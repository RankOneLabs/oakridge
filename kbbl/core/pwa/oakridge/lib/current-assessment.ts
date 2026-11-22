import { z } from "zod";
import { parseCurrent } from "./current-contract";
import type { SubnavSection } from "./artifact-subnav";

const evidence = z.object({ kind: z.enum(["file", "test", "output"]), ref: z.string(), detail: z.string().nullish() });
const identifier = z.string().min(1);
export const currentAssessmentSchema = z.object({
  head_sha: z.string(), verdict: z.enum(["pass", "pass_with_notes", "fail"]),
  item_assessments: z.array(z.object({ subject: z.object({ kind: identifier, id: identifier }),
    status: z.enum(["met", "partial", "not_met"]), observation: z.string(), evidence: z.array(evidence) })),
  additional_findings: z.array(z.object({ id: identifier, severity: z.enum(["blocking", "warning", "info"]), observation: z.string(), related_build_item_ids: z.array(identifier), evidence: z.array(evidence) })),
  test_evidence: z.object({ passed: z.number().int(), failed: z.number().int(), output: z.string().nullish(), summary: z.string().nullish(), cargo_test_output: z.string().nullish() }),
});
export type CurrentAssessment = z.infer<typeof currentAssessmentSchema>;
export type ItemAssessment = CurrentAssessment["item_assessments"][number];
type AdditionalFinding = CurrentAssessment["additional_findings"][number];
export const parseCurrentAssessment = (body: unknown) => parseCurrent(currentAssessmentSchema, body, "parse_current_assessment");
const SUBJECT_KIND_LABELS: Readonly<Record<string, string>> = { build_item: "Build item", requirement: "Requirement" };
/** Each workflow declares what its assessor grades; a kind without a set label reads as its words. */
export const selectSubjectKindLabel = (kind: string): string =>
  SUBJECT_KIND_LABELS[kind] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1).replaceAll("_", " ")}`;
export interface AssessmentStatusGroup { readonly status: ItemAssessment["status"]; readonly count: number; readonly items: readonly ItemAssessment[] }
export type AssessmentStatusFilter = "all" | "needs_attention" | ItemAssessment["status"];
export function selectItemAssessmentGroups(assessment: CurrentAssessment, filter: AssessmentStatusFilter = "all"): readonly AssessmentStatusGroup[] {
  return (["not_met", "partial", "met"] as const).filter(status => filter === "all" || (filter === "needs_attention" ? status !== "met" : filter === status))
    .map(status => ({ status, items: assessment.item_assessments.filter(item => item.status === status), count: assessment.item_assessments.filter(item => item.status === status).length }));
}
export interface AssessmentItemLabel { readonly id: string; readonly label: string }
export interface AttributedFinding { readonly finding: AdditionalFinding; readonly labels: readonly AssessmentItemLabel[]; readonly is_unattributed: boolean }
export function selectAdditionalFindings(assessment: CurrentAssessment, labels: readonly AssessmentItemLabel[] = []): readonly AttributedFinding[] {
  return assessment.additional_findings.map(finding => ({ finding, is_unattributed: finding.related_build_item_ids.length === 0,
    labels: finding.related_build_item_ids.map(id => ({ id, label: labels.find(label => label.id === id)?.label ?? id })) }));
}
export interface DerivedAssessmentVerdict { readonly verdict: CurrentAssessment["verdict"]; readonly has_mismatch: boolean }
export function selectDerivedVerdict(assessment: CurrentAssessment): DerivedAssessmentVerdict {
  const verdict = assessment.item_assessments.some(item => item.status !== "met") || assessment.additional_findings.some(finding => finding.severity === "blocking") ? "fail"
    : assessment.additional_findings.some(finding => finding.severity === "warning") ? "pass_with_notes" : "pass";
  return { verdict, has_mismatch: verdict !== assessment.verdict };
}

export type AssessmentSection = "items" | "findings" | "tests";
/** The current assessment viewer's subnav: item assessments, additional findings, then test evidence. */
export const selectAssessmentSections = (assessment: CurrentAssessment): readonly SubnavSection<AssessmentSection>[] => [
  { value: "items", label: "Items", count: assessment.item_assessments.length },
  { value: "findings", label: "Findings", count: assessment.additional_findings.length },
  { value: "tests", label: "Tests", count: null },
];
