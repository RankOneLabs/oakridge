/** An Oakridge artifact publication, in the order returned by artifact detail. */
export interface ArtifactAddress {
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  readonly publication_ordinal: number;
  readonly namespace: string;
}

export interface ObservationError {
  readonly operation: string;
  readonly entity_id: string;
  readonly detail: string;
}
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ObservationError };
export type Resolution =
  | { readonly kind: "resolved"; readonly revision_id: string; readonly occurrence_id: string }
  | { readonly kind: "unresolved"; readonly revision_id: string };

export function artifactAddressToObservationRevision(address: ArtifactAddress): Result<string> {
  const { run_id, unit_id, artifact_key, publication_ordinal, namespace } = address;
  if (![run_id, unit_id, artifact_key, namespace].every((part) => part.trim().length > 0)
    || !Number.isSafeInteger(publication_ordinal) || publication_ordinal < 1) {
    return { ok: false, error: { operation: "artifact_address_to_observation_revision",
      entity_id: `${run_id}/${unit_id}/${artifact_key}`, detail: "address requires nonempty fields and a 1-based publication ordinal" } };
  }
  return { ok: true, value: `oakridge:${namespace}:${unit_id}:${artifact_key}:${publication_ordinal}` };
}

export function resolveOccurrence(revision_id: string, occurrence_ids: readonly string[]): Result<Resolution> {
  if (occurrence_ids.length > 1) return { ok: false, error: { operation: "resolve_occurrence", entity_id: revision_id,
    detail: "revision contains multiple occurrences; item selector is required" } };
  return { ok: true, value: occurrence_ids.length === 0
    ? { kind: "unresolved", revision_id }
    : { kind: "resolved", revision_id, occurrence_id: occurrence_ids[0] ?? "" } };
}
