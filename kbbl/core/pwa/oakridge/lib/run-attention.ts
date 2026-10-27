import type { CohortLifecycleSummary, RepositoryKey, ReviewInboxItem } from "../types";

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

export interface UnitAttentionLabelInput {
  cohort_key: string | null;
  brief_title: string | null;
  repository_key: RepositoryKey | null;
}

/** The cohort, brief and repository associated with a unit's work. */
export function selectUnitAttentionLabel({ cohort_key, brief_title, repository_key }: UnitAttentionLabelInput): string {
  return [cohort_key, brief_title, repository_key].map((part) => part?.trim()).filter((part) => !!part).join(" · ");
}

type AttentionContext = Pick<ReviewInboxItem, "run_title" | "artifact_key">;

/** The run and artifact surrounding a unit's attention label. */
export function selectAttentionContext(work: AttentionContext): string {
  return [work.run_title, work.artifact_key].filter((part) => !!part).join(" · ");
}
