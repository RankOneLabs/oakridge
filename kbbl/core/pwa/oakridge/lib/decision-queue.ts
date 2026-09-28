import type { ReviewInboxItem } from "../types";

/**
 * One row of the inbox's decision list. A `settled` row is an item that left
 * the server's queue while the operator was looking at it (decided here,
 * decided elsewhere, or withdrawn). It keeps its place with no decision
 * controls, so the rows below never slide up under a pointer aimed at it.
 */
export type DecisionQueueEntry =
  | { readonly kind: "live"; readonly item: ReviewInboxItem }
  | { readonly kind: "settled"; readonly item: ReviewInboxItem };

/** Every previous row keeps its position; work that arrived since is appended. */
export function selectStableDecisionQueue(
  previous: readonly DecisionQueueEntry[],
  incoming: readonly ReviewInboxItem[],
): DecisionQueueEntry[] {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const kept = previous.map((entry): DecisionQueueEntry => {
    const current = incomingById.get(entry.item.id);
    return current ? { kind: "live", item: current } : { kind: "settled", item: entry.item };
  });
  const knownIds = new Set(previous.map((entry) => entry.item.id));
  const arrived = incoming
    .filter((item) => !knownIds.has(item.id))
    .map((item): DecisionQueueEntry => ({ kind: "live", item }));
  return [...kept, ...arrived];
}
