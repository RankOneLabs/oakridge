import { canonicalDigest } from "../canonical/canonical-json";
import type { ItemOccurrenceId } from "../domain/identity";
import { err, ok, type Result } from "../domain/primitives";

export interface OccurrenceIdentity {
  readonly producer: string;
  readonly namespace: string;
  readonly revision_id: string;
  readonly extractor_id: string;
  readonly extractor_version: string;
  readonly item_selector: string;
  readonly item_id_or_path: string;
}

export interface OccurrenceIdError { readonly operation: "occurrence_id"; readonly entity_id: string; readonly detail: string }

/** The seven fields are ordered as pinned by the L1 identity contract. */
export function occurrenceId(identity: OccurrenceIdentity): Result<ItemOccurrenceId, OccurrenceIdError> {
  const tuple = [identity.producer, identity.namespace, identity.revision_id, identity.extractor_id,
    identity.extractor_version, identity.item_selector, identity.item_id_or_path];
  const digest = canonicalDigest(tuple);
  return digest.ok ? ok(digest.value as unknown as ItemOccurrenceId)
    : err({ operation: "occurrence_id", entity_id: identity.revision_id, detail: digest.error.detail });
}
