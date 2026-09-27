import type { ReviewInboxItem } from "../types";

/** Actionable review work grouped by the run that owns it. */
export function selectRunAttentionCounts(
  items: readonly ReviewInboxItem[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.state !== "actionable") continue;
    counts.set(item.run_id, (counts.get(item.run_id) ?? 0) + 1);
  }
  return counts;
}
