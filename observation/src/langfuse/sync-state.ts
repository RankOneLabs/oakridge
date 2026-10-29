import type { CanonicalDigest } from "../domain/identity";
import type { LangfuseError, LangfuseObservationId, LangfuseScoreId } from "../ports/evaluation-backend";

/** Sync state belongs to a mapping or inbound item, never to a local execution. */
export type LangfuseSyncState =
  | { readonly status: "queued"; readonly mapping_key: CanonicalDigest; readonly queued_at: string }
  | { readonly status: "pending"; readonly mapping_key: CanonicalDigest; readonly last_checked_at: string }
  | { readonly status: "completed"; readonly mapping_key: CanonicalDigest; readonly completed_at: string }
  | { readonly status: "failed"; readonly mapping_key: CanonicalDigest; readonly error: LangfuseError; readonly failed_at: string }
  | { readonly status: "timed_out"; readonly mapping_key: CanonicalDigest; readonly timed_out_at: string }
  | { readonly status: "unmatched"; readonly score_id: LangfuseScoreId;
      readonly observation_id: LangfuseObservationId; readonly discovered_at: string }
  | { readonly status: "stale"; readonly score_id: LangfuseScoreId; readonly superseded_mapping_key: CanonicalDigest;
      readonly replacement_mapping_key: CanonicalDigest; readonly discovered_at: string };
