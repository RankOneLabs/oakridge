import type { ParkedGate } from "../artifact-types";

export function selectAssessmentCorrection(gate: ParkedGate | null, revision: string) {
  return gate?.decision_definitions?.find(decision =>
    (decision.operation === undefined || decision.operation === "plain") &&
    decision.submit.kind === "review" &&
    decision.submit.target_revision_id === revision &&
    decision.submit.effect === "request_changes" &&
    decision.fields.some(field => field.key === "feedback")
  ) ?? null;
}

export function selectInboxDecisionGate(inboxGate: ParkedGate, gates: readonly ParkedGate[]): ParkedGate | null {
  return gates.find((gate) => gate.id === inboxGate.id) ?? null;
}
