/**
 * DBOS serialises event and stream payloads through superjson, which wraps some
 * values as `{"json": ...}` and stores others bare, so every read has to accept
 * both shapes. #426 was a bug from a single site getting that wrong, and the
 * expression had been retyped at sixteen call sites across two repositories.
 * It lives here once instead.
 */
export const superjsonValue = (column: string): string => `COALESCE((${column}::jsonb)->'json', ${column}::jsonb)`;

/** The same unwrap as a lateral join, for queries that read the payload more than once. */
export const superjsonValueLateral = (column: string, alias: string): string =>
  `CROSS JOIN LATERAL (SELECT ${superjsonValue(column)} AS value) ${alias}`;

/**
 * The artifact a run-owned output slot points at is the one in effect. A
 * replacement published into an invalidated slot is a fresh chain root, so a
 * released predecessor keeps `lifecycle_state = 'released'` and a read keyed
 * on lifecycle alone would return both; the slot pointer returns exactly one.
 */
export const effectiveArtifactPredicate = (artifactAlias: string): string =>
  `EXISTS (SELECT 1 FROM oakridge.run_output_slot effective_slot WHERE effective_slot.artifact_revision_id = ${artifactAlias}.id)`;
