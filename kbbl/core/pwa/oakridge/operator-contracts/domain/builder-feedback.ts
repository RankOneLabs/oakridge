// Generated from domain/builder-feedback.ts; never edit.
import type { OperatorAddedActionEntry, OperatorProposedActionEntry } from "./adjudication";

/** D6: assessor entries in next_actions order, then added actions in entry order. */
export function composeBuilderFeedback(entries: readonly OperatorProposedActionEntry[], added: readonly OperatorAddedActionEntry[]): string {
  return [
    ...entries.filter((entry) => entry.audience === "builder" && entry.disposition !== "rejected")
      .map((entry) => `${entry.action_id}: ${entry.disposition === "modified" ? entry.final_text : entry.original_text}`),
    ...added.filter((entry) => entry.audience === "builder").map((entry) => `${entry.action_id}: ${entry.final_text}`),
  ].join("\n");
}
