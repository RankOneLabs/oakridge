import { describe, expect, it } from "vitest";
import { CURRENT_ASSESSMENT } from "../__fixtures__/current-assessments";
import type { ParkedGate } from "../artifact-types";
import type { OperatorDecisionDefinition, OperatorRevisionDecision } from "../operator-contracts/projections/unit-view";
import { initialAdjudication, NO_REVIEW_REASON, selectAdjudicationBlockReason, selectAdjudicationDecision, selectAdjudicationDecisions, selectAdjudicationGate, selectAssessmentChangeDecision, setDisposition, type ReviewDecisionDefinition } from "./assessment-handoff";

const definition = (decision: string, availability: Partial<OperatorDecisionDefinition> = {}): OperatorDecisionDefinition => ({
  key: decision, label: decision, payload_schema: "adjudication", fields: [],
  submit: { kind: "review", review: "assessment_review", decision, effect: decision === "accept" ? "approve" : "request_changes", target_revision_id: "assessment-rev" }, ...availability,
});
const gate: ParkedGate = {
  id: "gate-1", gate_type: "assessment_review", gate_step: "assessment_review", run_id: "run-1", stage_name: "cohort",
  unit_id: "alpha", artifact_revision_id: "assessment-rev", worktree: null, resume_actions: ["approve"],
  offered_decisions: ["accept", "request_build_changes"], run_state: "active", actionable: true,
  decision_definitions: [definition("accept"), definition("request_build_changes")],
};
const declared = (decision: OperatorDecisionDefinition): ReviewDecisionDefinition =>
  ({ definition: decision, effect: decision.submit.kind === "review" ? decision.submit.effect : "approve" });
const accept = declared(definition("accept"));
const keys = (offered: ParkedGate): string[] => selectAdjudicationDecisions(offered).map(({ definition }) => definition.key);
const assessmentChanges: OperatorDecisionDefinition = { key: "request_assessment_changes", label: "Request assessment changes", payload_schema: "{feedback: text}",
  fields: [{ key: "feedback", label: "What must the assessment change?" }],
  submit: { kind: "review", review: "expansion_review", decision: "request_assessment_changes", effect: "request_changes", target_revision_id: "assessment-rev" } };
const expansionReview: ParkedGate = { ...gate, gate_step: "expansion_review", offered_decisions: ["send_to_expander", "request_assessment_changes", "accept"],
  decision_definitions: [definition("send_to_expander"), assessmentChanges, definition("accept")] };
const recorded = { id: "d1", review: "assessment_review", decision: "accept", effect: "approve", target_revision_id: "assessment-rev", payload: {}, created_at: "2026-11-18T00:00:00Z" } as OperatorRevisionDecision;
const decided = CURRENT_ASSESSMENT.next_actions.reduce((state, action) => setDisposition(state, action.id, { kind: "accept" }), initialAdjudication(CURRENT_ASSESSMENT));

describe("adjudication gate", () => {
  it("is open on the gate's revision before any decision", () => {
    expect(selectAdjudicationGate({ gate, revisionId: "assessment-rev", decisions: [], hasSubmitted: false }).isOpen).toBe(true);
  });
  it("is closed on a stale revision the gate no longer targets", () => {
    expect(selectAdjudicationGate({ gate, revisionId: "older-rev", decisions: [], hasSubmitted: false }).isOpen).toBe(false);
  });
  it("is closed and recorded once the revision has a decision", () => {
    const state = selectAdjudicationGate({ gate, revisionId: "assessment-rev", decisions: [recorded], hasSubmitted: false });
    expect([state.isOpen, state.isRecorded, state.recordedDecision?.id]).toEqual([false, true, "d1"]);
  });
  it("is closed while a submitted decision awaits recording", () => {
    expect(selectAdjudicationGate({ gate, revisionId: "assessment-rev", decisions: [], hasSubmitted: true }).isOpen).toBe(false);
  });
  it("offers development's declared accept and send-back", () => {
    expect(keys(gate)).toEqual(["accept", "request_build_changes"]);
  });
  it("offers integration's declared send-back", () => {
    expect(keys({ ...gate, gate_step: "integration_review", decision_definitions: [definition("accept"), definition("request_changes")] })).toEqual(["accept", "request_changes"]);
  });
  it("offers study's send-back under its own key, approval first", () => {
    expect(keys(expansionReview)).toEqual(["accept", "send_to_expander"]);
  });
  it("offers nothing the gate does not declare", () => {
    expect(keys({ ...gate, decision_definitions: [definition("request_build_changes")] })).toEqual(["request_build_changes"]);
  });
  it("finds the plain request for assessment changes beside the adjudicated send-back", () => {
    expect(selectAssessmentChangeDecision(expansionReview)?.key).toBe("request_assessment_changes");
  });
  it("an available decision submits on the gate's revision", () => {
    const decision = selectAdjudicationDecision(gate, accept);
    expect(decision.kind === "available" && [decision.definition.key, decision.revision_id]).toEqual(["accept", "assessment-rev"]);
  });
  it("an unavailable decision reports its guard's reason", () => {
    const guarded = { ...gate, decision_definitions: [definition("accept", { is_available: false, disabled_reason: "Resolve findings first" })] };
    expect(selectAdjudicationBlockReason(decided, guarded, declared(definition("accept", { is_available: false, disabled_reason: "Resolve findings first" })))).toBe("Resolve findings first");
  });
  it("a gate without an open revision cannot take a decision", () => {
    expect(selectAdjudicationBlockReason(decided, { ...gate, artifact_revision_id: null }, accept)).toBe(NO_REVIEW_REASON);
  });
  it("undecided actions block before the decision's guard", () => {
    expect(selectAdjudicationBlockReason(initialAdjudication(CURRENT_ASSESSMENT), gate, accept)).not.toBeNull();
  });
  it("a fully decided adjudication on an available decision is sendable", () => {
    expect(selectAdjudicationBlockReason(decided, gate, accept)).toBeNull();
  });
});
