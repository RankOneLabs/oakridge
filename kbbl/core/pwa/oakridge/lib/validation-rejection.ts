// The validator's recorded rejection of a revision, read from the authority's decision history; never re-derived from the rules.
import type { OperatorDecisionDefinition, OperatorRevisionDecision } from "../operator-contracts/projections/unit-view";
import { VALIDATION_REVIEW } from "../operator-contracts/validation";

const selectFeedbackText = (payload: OperatorRevisionDecision["payload"]): string | null =>
  typeof payload === "object" && payload !== null && "feedback" in payload && typeof payload.feedback === "string" ? payload.feedback : null;

/** The validator's message when it rejected the revision, which the core then never lets the operator accept. */
export function selectValidationRejection(decisions: readonly OperatorRevisionDecision[], revisionId: string): string | null {
  const rejection = decisions.findLast(decision => decision.review === VALIDATION_REVIEW && decision.target_revision_id === revisionId);
  return rejection ? selectFeedbackText(rejection.payload) ?? "The validator rejected this revision." : null;
}

/** The validator's message on any revision a review's decisions target. */
export const selectReviewValidationRejection = (decisions: readonly OperatorRevisionDecision[], offered: readonly OperatorDecisionDefinition[]): string | null =>
  offered.flatMap(definition => definition.submit.kind === "review" ? [definition.submit.target_revision_id] : [])
    .map(target => selectValidationRejection(decisions, target)).find(message => message !== null) ?? null;

/** What the operator reads wherever an adjudicated review is withheld by a validator rejection. */
export const selectValidationRejectionNotice = (message: string): string => `This assessment failed validation, so it cannot be accepted: ${message}`;
