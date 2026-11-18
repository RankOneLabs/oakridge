import { describe, expect, it } from "vitest";
import { CURRENT_ASSESSMENT } from "../__fixtures__/current-assessments";
import type { ParkedGate } from "../artifact-types";
import type { OperatorDecisionDefinition, OperatorRevisionDecision } from "../operator-contracts/projections/unit-view";
import { initialAdjudication, NO_REVIEW_REASON, selectAdjudicationBlockReason, selectAdjudicationDecision, selectAdjudicationEffects, selectAdjudicationGate, setDisposition } from "./assessment-handoff";

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
  it("offers integration changes only at integration review", () => {
    expect(selectAdjudicationEffects({ ...gate, gate_step: "integration_review", offered_decisions: ["accept", "request_changes"] })).toEqual(["accept", "request_changes"]);
  });
  it("offers nothing the gate does not", () => {
    expect(selectAdjudicationEffects({ ...gate, offered_decisions: ["request_build_changes"] })).toEqual(["request_build_changes"]);
  });
  it("an available decision submits on the gate's revision", () => {
    const decision = selectAdjudicationDecision(gate, "accept");
    expect(decision.kind === "available" && [decision.definition.key, decision.revision_id]).toEqual(["accept", "assessment-rev"]);
  });
  it("an unavailable decision reports its guard's reason", () => {
    const guarded = { ...gate, decision_definitions: [definition("accept", { is_available: false, disabled_reason: "Resolve findings first" })] };
    expect(selectAdjudicationBlockReason(decided, guarded, "accept")).toBe("Resolve findings first");
  });
  it("a decision the gate does not define cannot be submitted", () => {
    expect(selectAdjudicationBlockReason(decided, { ...gate, decision_definitions: [] }, "accept")).toBe(NO_REVIEW_REASON);
  });
  it("undecided actions block before the decision's guard", () => {
    expect(selectAdjudicationBlockReason(initialAdjudication(CURRENT_ASSESSMENT), gate, "accept")).not.toBeNull();
  });
  it("a fully decided adjudication on an available decision is sendable", () => {
    expect(selectAdjudicationBlockReason(decided, gate, "accept")).toBeNull();
  });
});
