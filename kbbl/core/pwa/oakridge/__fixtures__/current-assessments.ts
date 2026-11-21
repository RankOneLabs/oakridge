import type { OperatorBodyValue } from "../operator-contracts/projections/unit-view";
import type { CurrentAssessment } from "../lib/current-assessment";
import type { OperatorAdjudication } from "../operator-contracts/domain/adjudication";
import type { OperatorRevisionDecision, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { composeReworkFeedback } from "../operator-contracts/domain/rework-feedback";
export const CURRENT_ASSESSMENT: CurrentAssessment = {
  head_sha: "current-head", verdict: "pass_with_notes", test_evidence: { passed: 4, failed: 0 },
  item_assessments: [{ subject: { kind: "build_item", id: "B1" }, status: "met", observation: "The requested behavior works.", evidence: [{ kind: "test", ref: "build.test.ts" }] }],
  additional_findings: [{ id: "F1", severity: "warning", observation: "An unrelated regression needs investigation.", related_build_item_ids: ["B1"], evidence: [{ kind: "file", ref: "regression.ts", detail: "Existing behavior regressed." }] }],
  next_actions: [
    { id: "00000000-0000-4000-8000-000000000001", audience: "rework", source: { kind: "additional_finding", id: "F1" }, text: "Investigate the regression." },
    { id: "00000000-0000-4000-8000-000000000002", audience: "operator", source: { kind: "item_assessment", id: "B1" }, text: "Confirm the deployment window." },
  ],
};
export const MET_WITH_REGRESSION: CurrentAssessment = { ...CURRENT_ASSESSMENT, verdict: "fail", additional_findings: CURRENT_ASSESSMENT.additional_findings.map(finding => ({ ...finding, severity: "blocking" })) };
export const PARTIAL_ASSESSMENT: CurrentAssessment = { ...CURRENT_ASSESSMENT, verdict: "fail", item_assessments: CURRENT_ASSESSMENT.item_assessments.map(item => ({ ...item, status: "partial" })) };
export const NOT_MET_ASSESSMENT: CurrentAssessment = { ...PARTIAL_ASSESSMENT, item_assessments: PARTIAL_ASSESSMENT.item_assessments.map(item => ({ ...item, status: "not_met" })) };
export const OPERATOR_ONLY_ASSESSMENT: CurrentAssessment = { ...CURRENT_ASSESSMENT, next_actions: CURRENT_ASSESSMENT.next_actions.filter(action => action.audience === "operator") };
export const CURRENT_INTEGRATION_ASSESSMENT: CurrentAssessment = { ...CURRENT_ASSESSMENT, item_assessments: CURRENT_ASSESSMENT.item_assessments.map(item => ({ ...item, subject: { kind: "requirement", id: "R1" } })), next_actions: [] };
export const RECORDED_ADJUDICATION: OperatorAdjudication = (() => {
  const entries = CURRENT_ASSESSMENT.next_actions.map(action => ({ action_id: action.id, original_text: action.text, audience: action.audience, source: action.source,
    disposition: action.audience === "rework" ? "rejected" as const : "accepted" as const, ...(action.audience === "rework" ? { reason: "Already fixed in another change." } : {}) }));
  return { entries, added_actions: [], rework_feedback: composeReworkFeedback(entries, []) };
})();
export const RECORDED_ADJUDICATION_HISTORY: readonly OperatorRevisionDecision[] = [{ id: "decision:1", review: "assessment_review", decision: "accept", effect: "approve", target_revision_id: "assessment:1",
  payload: JSON.parse(JSON.stringify(RECORDED_ADJUDICATION)) as OperatorBodyValue, adjudication: RECORDED_ADJUDICATION, actor: { kind: "operator", subject: "operator:fixture" }, created_at: "2026-11-18T00:00:00Z" }];
export const MODIFIED_ADJUDICATION_HISTORY: readonly OperatorRevisionDecision[] = (() => {
  const entries = RECORDED_ADJUDICATION.entries.map(entry => entry.audience === "rework"
    ? { ...entry, disposition: "modified" as const, final_text: "Add a regression test.", reason: "Narrow the follow-up." } : entry);
  const added_actions: OperatorAdjudication["added_actions"] = (["rework", "operator"] as const).map((audience, index) => ({
    action_id: `00000000-0000-4000-8000-00000000000${index + 3}`, origin: "operator", audience,
    source: { kind: "item_assessment", id: "B1" }, final_text: `Added ${audience} follow-up.`, reason: "Support the rollout.",
  }));
  const adjudication: OperatorAdjudication = { entries, added_actions, rework_feedback: composeReworkFeedback(entries, added_actions) };
  return [{ ...RECORDED_ADJUDICATION_HISTORY[0], target_revision_id: "build:1", assessment_revision_id: "assessment:1",
    payload: JSON.parse(JSON.stringify(adjudication)) as OperatorBodyValue, adjudication }];
})();

/** Study's slice report review with its assessment distinct from all decision targets. */
export function sliceReportReviewUnit(unit: OperatorUnitView): OperatorUnitView {
  const assessment = unit.artifacts.find(artifact => artifact.artifact_key === "assessment");
  if (!assessment?.latest_revision) throw new Error("Expected an assessment artifact");
  const revision = assessment.latest_revision;
  const artifacts = ["plan", "slice_report", "slice_build", "slice_assessment"].map(artifact_key => ({
    ...assessment, artifact_key, is_adjudicated: artifact_key === "slice_assessment",
    latest_revision: { ...revision, artifact_key, id: artifact_key === "slice_assessment" ? "slice_assessment:2" : `${artifact_key}:1` },
  }));
  return { ...unit, stage: "design", artifacts, decisions: [
    { key: "change_design", label: "Change design", payload_schema: "{feedback: text}", adjudication: null, assessment: "slice_assessment",
      fields: [{ key: "feedback", label: "What must the plan change?" }],
      submit: { kind: "review", review: "slice_report_review", decision: "change_design", effect: "request_changes", target_revision_id: "plan:1" } },
    { key: "expand", label: "Expand", payload_schema: "{}", adjudication: "accept", assessment: "slice_assessment", fields: [],
      submit: { kind: "review", review: "slice_report_review", decision: "expand", effect: "approve", target_revision_id: "slice_report:1" } },
    { key: "send_feedback_to_builder", label: "Send actions to builder", payload_schema: "{}", adjudication: "feedback", assessment: "slice_assessment", fields: [],
      submit: { kind: "review", review: "slice_report_review", decision: "send_feedback_to_builder", effect: "request_changes", target_revision_id: "slice_build:1" } },
    { key: "send_to_builder", label: "Send to builder", payload_schema: "{feedback: text}", adjudication: null, assessment: "slice_assessment",
      fields: [{ key: "feedback", label: "What must the slice builder fix?" }],
      submit: { kind: "review", review: "slice_report_review", decision: "send_to_builder", effect: "request_changes", target_revision_id: "slice_build:1" } },
  ] };
}
