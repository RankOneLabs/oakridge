import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
export const CURRENT_ASSESSMENT = {
  head_sha: "current-head", verdict: "pass_with_notes", test_evidence: { passed: 4, failing_tests: 0 },
  item_assessments: [{ subject: { kind: "build_item", id: "B1" }, status: "met", finding_note: "The requested behavior works.", supporting_citations: [{ kind: "test", citation_location: "build.test.ts" }] }],
  additional_findings: [{ id: "F1", severity: "warning", finding_note: "An unrelated regression needs investigation.", related_build_item_ids: ["B1"], supporting_citations: [{ kind: "file", citation_location: "regression.ts", detail: "Existing behavior regressed." }] }],
  proposals: [],
  verifications: [],
};
export const MET_WITH_REGRESSION = { ...CURRENT_ASSESSMENT, verdict: "fail", additional_findings: CURRENT_ASSESSMENT.additional_findings.map(finding => ({ ...finding, severity: "blocking" })) };
export const PARTIAL_ASSESSMENT = { ...CURRENT_ASSESSMENT, verdict: "fail", item_assessments: CURRENT_ASSESSMENT.item_assessments.map(item => ({ ...item, status: "partial" })) };
export const NOT_MET_ASSESSMENT = { ...PARTIAL_ASSESSMENT, item_assessments: PARTIAL_ASSESSMENT.item_assessments.map(item => ({ ...item, status: "not_met" })) };
export const CURRENT_INTEGRATION_ASSESSMENT = { ...CURRENT_ASSESSMENT,
  item_assessments: CURRENT_ASSESSMENT.item_assessments.map(item => ({ ...item, subject: { kind: "requirement", id: "R1" } })) };

/** Study's slice report review with its assessment distinct from all decision targets. */
export function sliceReportReviewUnit(unit: OperatorUnitView): OperatorUnitView {
  const assessment = unit.artifacts.find(artifact => artifact.artifact_key === "assessment");
  if (!assessment?.latest_revision) throw new Error("Expected an assessment artifact");
  const revision = assessment.latest_revision;
  const artifacts = ["plan", "slice_report", "slice_build", "slice_assessment"].map(artifact_key => ({
    ...assessment, artifact_key, has_assessment_operations: artifact_key === "slice_assessment",
    latest_revision: { ...revision, artifact_key, id: artifact_key === "slice_assessment" ? "slice_assessment:2" : `${artifact_key}:1` },
  }));
  return { ...unit, stage: "design", artifacts, decisions: [
    { key: "change_design", label: "Change design", payload_schema: "{feedback: text}", operation: "plain", assessment: "slice_assessment",
      fields: [{ key: "feedback", label: "What must the plan change?" }],
      submit: { kind: "review", review: "slice_report_review", decision: "change_design", effect: "request_changes", target_revision_id: "plan:1" } },
    { key: "expand", label: "Expand", payload_schema: "{}", operation: "approve_assessment", assessment: "slice_assessment", fields: [],
      submit: { kind: "review", review: "slice_report_review", decision: "expand", effect: "approve", target_revision_id: "slice_report:1" } },
    { key: "send_feedback_to_builder", label: "Send actions to builder", payload_schema: "{}", operation: "dispatch_feedback", assessment: "slice_assessment", fields: [],
      submit: { kind: "review", review: "slice_report_review", decision: "send_feedback_to_builder", effect: "request_changes", target_revision_id: "slice_build:1" } },
    { key: "send_to_builder", label: "Send to builder", payload_schema: "{feedback: text}", operation: "plain", assessment: "slice_assessment",
      fields: [{ key: "feedback", label: "What must the slice builder fix?" }],
      submit: { kind: "review", review: "slice_report_review", decision: "send_to_builder", effect: "request_changes", target_revision_id: "slice_build:1" } },
  ] };
}
