import type { AddedActionEntry, ProposedActionEntry } from "./adjudication";

/** D6: assessor entries in next_actions order, then added actions in entry order. */
export function composeBuilderFeedback(entries: readonly ProposedActionEntry[], added: readonly AddedActionEntry[]): string {
  return [
    ...entries.filter((entry) => entry.audience === "builder" && entry.disposition !== "rejected")
      .map((entry) => `${entry.action_id}: ${entry.disposition === "modified" ? entry.final_text : entry.original_text}`),
    ...added.filter((entry) => entry.audience === "builder").map((entry) => `${entry.action_id}: ${entry.final_text}`),
  ].join("\n");
}
