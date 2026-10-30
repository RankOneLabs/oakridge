import type { ItemOccurrenceId } from "../../domain/identity";
import type { SelectedItem } from "../../projection/extractor";

export interface CapturedItem extends SelectedItem {
  readonly occurrence_id: ItemOccurrenceId;
  readonly revision_id: string;
}
export interface CapturedRevision {
  readonly revision_id: string;
  readonly unit_id: string;
  readonly artifact_kind: string;
  readonly recorded_at: Date;
  readonly predecessor_id?: string | null;
  readonly items: readonly CapturedItem[];
}

/** Explicit historical backfill policy. Live selection retains all captured revisions. */
export function latestRevisions(revisions: readonly CapturedRevision[]): readonly CapturedRevision[] {
  const latest = new Map<string, CapturedRevision>();
  for (const revision of revisions) {
    const key = `${revision.unit_id}\u0000${revision.artifact_kind}`;
    const current = latest.get(key);
    if (!current || revision.recorded_at > current.recorded_at) latest.set(key, revision);
  }
  return [...latest.values()].sort((a, b) => a.revision_id.localeCompare(b.revision_id));
}
export interface RevisionSelection {
  readonly policy: "live_all_revisions" | "historical_latest_per_unit_kind";
  readonly revisions: readonly CapturedRevision[];
}
export function selectCapturedRevisions(revisions: readonly CapturedRevision[], policy: RevisionSelection["policy"]): RevisionSelection {
  return { policy, revisions: policy === "live_all_revisions" ? revisions : latestRevisions(revisions) };
}
