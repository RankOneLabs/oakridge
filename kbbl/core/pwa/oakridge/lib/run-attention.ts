import type { CohortLifecycleSummary, ReviewInboxItem } from "../types";

/** Actionable review work grouped by the run that owns it. */
export function selectRunAttentionCounts(
  items: readonly ReviewInboxItem[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.state !== "actionable" && item.kind !== "pull_request_mismatch") continue;
    counts.set(item.run_id, (counts.get(item.run_id) ?? 0) + 1);
  }
  return counts;
}

/** Unit ids are scoped to a stage; scalar stages all mint unit "0". */
type ReviewCohortIdentity = Pick<CohortLifecycleSummary, "run_id" | "stage_instance_id" | "unit_id">;

export function selectReviewCohortKey(cohort: ReviewCohortIdentity): string {
  return `${cohort.run_id}:${cohort.stage_instance_id}:${cohort.unit_id}`;
}
