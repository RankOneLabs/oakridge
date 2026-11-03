import type { SlotSource, SubjectBinding } from "./pilot-recipe";
import type { ItemOccurrenceId } from "../../domain/identity";
import type { RecordedProvenance } from "../eligibility";
import type { LinkReference, SelectedItem } from "../../projection/extractor";

export interface CapturedItem extends SelectedItem {
  readonly occurrence_id: ItemOccurrenceId;
  readonly revision_id: string;
}
export interface CapturedRevision extends RecordedProvenance {
  readonly revision_id: string;
  readonly unit_id: string;
  readonly artifact_kind: string;
  readonly recorded_at: Date;
  readonly predecessor_id?: string | null;
  readonly items: readonly CapturedItem[];
  readonly reviewed_commit?: string;
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

export interface LinkedItems {
  readonly resolved: readonly CapturedItem[];
  /** Evidence refs of outward links naming an item the pool does not hold. */
  readonly dangling: readonly string[];
}

/** Walk one pinned relation from a subject item. `out` follows the subject's own links to items
 * in `pool`; `in` finds the items in `pool` that link back to the subject. The three pilot
 * builders each did this inline against their own literals; the relation now comes from the pin
 * and the revision scope of `pool` stays the builder's decision. */
export function linkedItems(subject: SelectedItem, relation: Extract<SlotSource, { from: "linked" }>,
  subject_binding: SubjectBinding, pool: readonly CapturedItem[]): LinkedItems {
  const candidates = pool.filter((item) => item.item_kind === relation.item_kind);
  if (relation.direction === "in") {
    return { dangling: [], resolved: candidates.filter((item) => item.links.some((link) =>
      link.type === relation.link_type && link.target_artifact_kind === subject_binding.artifact_kind
      && link.target_item_kind === subject_binding.item_kind && link.target_scope === subject.item_scope
      && link.target_local_id === subject.producer_local_id)) };
  }
  const matches = subject.links.filter((link) => link.type === relation.link_type
    && link.target_artifact_kind === relation.artifact_kind && link.target_item_kind === relation.item_kind)
    .map((link) => ({ link, item: candidates.find((item) => item.item_scope === link.target_scope
      && item.producer_local_id === link.target_local_id) }));
  return { resolved: matches.flatMap(({ item }) => item ? [item] : []),
    dangling: matches.flatMap(({ link, item }) => item ? [] : [link.evidence_ref]) };
}

/** Outward links a subject declares for a relation, resolved or not. Distinguishes "the subject
 * cites nothing" from "the subject cites something absent". */
export function declaredLinks(subject: SelectedItem, relation: Extract<SlotSource, { from: "linked" }>)
  : readonly LinkReference[] {
  return subject.links.filter((link) => link.type === relation.link_type
    && link.target_artifact_kind === relation.artifact_kind && link.target_item_kind === relation.item_kind);
}
