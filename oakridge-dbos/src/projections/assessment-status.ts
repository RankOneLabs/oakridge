import type { AssessmentStatus, AssignmentProgress, AssignmentRound } from "../core-client/core-types";
import type { AssessmentFacts } from "../storage/assessment-facts";

export function selectCurrentRound(facts: AssessmentFacts, assignment: string): AssignmentRound | undefined {
  return facts.rounds.filter(round => round.assignment === assignment).reduce<AssignmentRound | undefined>(
    (latest, round) => latest === undefined || round.ordinal > latest.ordinal ? round : latest, undefined);
}

export function selectRoundProgress(facts: AssessmentFacts, round: AssignmentRound): AssignmentProgress {
  if (!facts.updates.some(update => update.round === round.id)) return "awaiting_update";
  const verification = facts.verifications.findLast(value => value.round === round.id);
  if (!verification) return "awaiting_verification";
  if (verification.outcome === "verified") return "assessor_verified";
  return facts.rejections.some(value => value.assignment === round.assignment)
    ? "accepted_by_operator" : "returned_for_update";
}

export function selectAssessmentStatus(facts: AssessmentFacts): AssessmentStatus {
  return {
    unit: facts.unit, assessment_artifact: facts.artifact, assessment_revision: facts.revision,
    approval: facts.approval?.assessment_revision === facts.revision
      ? { kind: "approved", approval: facts.approval.id } : { kind: "pending" },
    unresolved_proposals: facts.items.filter(item => item.origin.kind === "proposal"
      && !facts.rejections.some(value => value.item === item.id && value.assignment == null)
      && !facts.assignments.some(value => value.item === item.id)).map(item => item.id),
    items: facts.items.map(item => ({ item: item.id, assignments: facts.assignments.filter(value => value.item === item.id).flatMap(assignment => {
      const round = selectCurrentRound(facts, assignment.id);
      return round ? [{ assignment: assignment.id, recipient: assignment.recipient, current_round: round.id,
        progress: selectRoundProgress(facts, round) }] : [];
    }) })),
  };
}
