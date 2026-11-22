import type { AssignmentRound, FeedbackItem } from "../core-client/core-types";

export function renderRoundDelivery(round: AssignmentRound, item: FeedbackItem): string {
  const citation = item.citation == null ? [] : [`Citation revision: ${item.citation.revision_id}`, `Citation pointer: ${JSON.stringify(item.citation.pointer)}`];
  return [`Assignment round: ${round.id}`, round.instruction, ...citation].join("\n");
}
