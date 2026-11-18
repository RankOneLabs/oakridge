import type { OperatorBodyValue } from "../operator-contracts/projections/unit-view";
import type { CurrentAssessment } from "../lib/current-assessment";
import type { OperatorAdjudication } from "../operator-contracts/domain/adjudication";
import type { OperatorRevisionDecision } from "../operator-contracts/projections/unit-view";
import { composeBuilderFeedback } from "../operator-contracts/domain/builder-feedback";
export const CURRENT_ASSESSMENT: CurrentAssessment = {
  head_sha: "current-head", verdict: "pass_with_notes", test_evidence: { passed: 4, failed: 0 },
  item_assessments: [{ subject: { kind: "build_item", id: "B1" }, status: "met", observation: "The requested behavior works.", evidence: [{ kind: "test", ref: "build.test.ts" }] }],
  additional_findings: [{ id: "F1", severity: "warning", observation: "An unrelated regression needs investigation.", related_build_item_ids: ["B1"], evidence: [{ kind: "file", ref: "regression.ts", detail: "Existing behavior regressed." }] }],
  next_actions: [
    { id: "00000000-0000-4000-8000-000000000001", audience: "builder", source: { kind: "additional_finding", id: "F1" }, text: "Investigate the regression." },
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
    disposition: action.audience === "builder" ? "rejected" as const : "accepted" as const, ...(action.audience === "builder" ? { reason: "Already fixed in another change." } : {}) }));
  return { entries, added_actions: [], builder_feedback: composeBuilderFeedback(entries, []) };
})();
export const RECORDED_ADJUDICATION_HISTORY: readonly OperatorRevisionDecision[] = [{ id: "decision:1", review: "assessment_review", decision: "accept", effect: "approve", target_revision_id: "assessment:1",
  payload: JSON.parse(JSON.stringify(RECORDED_ADJUDICATION)) as OperatorBodyValue, adjudication: RECORDED_ADJUDICATION, actor: { kind: "operator", subject: "operator:fixture" }, created_at: "2026-11-18T00:00:00Z" }];
export const MODIFIED_ADJUDICATION_HISTORY: readonly OperatorRevisionDecision[] = (() => {
  const entries = RECORDED_ADJUDICATION.entries.map(entry => entry.audience === "builder"
    ? { ...entry, disposition: "modified" as const, final_text: "Add a regression test.", reason: "Narrow the follow-up." } : entry);
  const added_actions: OperatorAdjudication["added_actions"] = (["builder", "operator"] as const).map((audience, index) => ({
    action_id: `00000000-0000-4000-8000-00000000000${index + 3}`, origin: "operator", audience,
    source: { kind: "item_assessment", id: "B1" }, final_text: `Added ${audience} follow-up.`, reason: "Support the rollout.",
  }));
  const adjudication: OperatorAdjudication = { entries, added_actions, builder_feedback: composeBuilderFeedback(entries, added_actions) };
  return [{ ...RECORDED_ADJUDICATION_HISTORY[0], target_revision_id: "build:1", assessment_revision_id: "assessment:1",
    payload: JSON.parse(JSON.stringify(adjudication)) as OperatorBodyValue, adjudication }];
})();
