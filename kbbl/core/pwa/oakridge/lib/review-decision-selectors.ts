import { parseCompositeId } from "../adapters/core";
import type { ParkedGate } from "../artifact-types";

export function selectAssessmentCorrection(gate: ParkedGate | null, revision: string) {
  return gate?.decision_definitions?.find(decision =>
    decision.adjudication == null &&
    decision.submit.kind === "review" &&
    decision.submit.target_revision_id === revision &&
    decision.submit.effect === "request_changes" &&
    decision.fields.some(field => field.key === "feedback")
  ) ?? null;
}

export function selectInboxDecisionGate(inboxGate: ParkedGate, gates: readonly ParkedGate[]): ParkedGate | null {
  const inboxId = parseCompositeId(inboxGate.id, "gate");
  if (!inboxId.ok) return null;
  return gates.find(gate => {
    if (gate.gate_step !== inboxId.value.name || gate.assessment_revision_id !== inboxGate.artifact_revision_id) return false;
    const id = parseCompositeId(gate.id, "gate");
    return id.ok && id.value.unitId === inboxId.value.unitId;
  }) ?? null;
}
