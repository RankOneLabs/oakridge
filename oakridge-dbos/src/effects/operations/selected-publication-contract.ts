import type { ScopedSnapshot } from "../../core-client/core-types";

export { MAX_SNAPSHOT_BYTES } from "../../core-client/client";

/**
 * v1 rendered a hand-written publication contract here, naming output slots
 * and fact routes that v2 does not have. An agent now publishes by emitting a
 * `revision_published` event, and every word it reads comes from the pinned
 * prompt catalog, so there is no prose to render from this module.
 */

export interface SnapshotSection { readonly section: string; readonly bytes: number }
export interface SnapshotMeasurement {
  readonly bytes: number;
  readonly largest_sections: readonly SnapshotSection[];
}

const SECTIONS = ["units", "attempts", "revisions", "decisions", "retry_events"] as const;

/** Which part of a scoped snapshot is driving its size, for the oversize diagnostic. */
export function measureSnapshotSize(snapshot: ScopedSnapshot): SnapshotMeasurement {
  const largest_sections = SECTIONS
    .map((section) => ({ section, bytes: Buffer.byteLength(JSON.stringify(snapshot[section] ?? [])) }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 5);
  return { bytes: Buffer.byteLength(JSON.stringify(snapshot)), largest_sections };
}
