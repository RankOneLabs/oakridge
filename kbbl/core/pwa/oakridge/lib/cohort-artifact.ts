import type { ArtifactDetail, ArtifactRevision, RunDetail } from "../types";

/** Whether a sibling artifact for the same cohort could be read, and why not when it could not. */
export type CohortArtifactLookup<T> =
  | { kind: "loading" }
  | { kind: "missing"; cohort_label: string | null }
  | { kind: "error"; cohort_label: string | null }
  | { kind: "found"; value: T };

/** The latest artifact of a type the run published for a cohort, or null when it has none. */
export function selectCohortArtifactId(run: RunDetail, typeId: string, cohortLabel: string): string | null {
  const matches = run.stages
    .flatMap((stage) => stage.artifacts)
    .filter((artifact) => artifact.type_id === typeId && artifact.label === cohortLabel);
  const latest = matches.reduce<(typeof matches)[number] | null>((best, artifact) => (best && best.version >= artifact.version ? best : artifact), null);
  return latest?.id ?? null;
}

/** The latest revision written at or before `asOf`; revisions arrive oldest first. */
export function selectRevisionAsOf(revisions: ArtifactRevision[], asOf: string): ArtifactRevision | null {
  const cutoff = Date.parse(asOf);
  return revisions.filter((revision) => Date.parse(revision.created_at) <= cutoff).at(-1) ?? null;
}

/** The slice of a query the lookup needs. */
export interface QueryState<T> {
  data: T | undefined;
  is_loading: boolean;
  is_error: boolean;
}

export interface CohortArtifactSources {
  cohort_label: string | null;
  as_of: string;
  run: QueryState<RunDetail>;
  artifact_id: string | null;
  detail: QueryState<ArtifactDetail>;
}

type Pending = { kind: "loading" } | { kind: "missing"; cohort_label: string | null } | { kind: "error"; cohort_label: string | null };

/** Data wins over a failed background refetch; without data, loading and failure are told apart from absence. */
function selectPending(query: QueryState<unknown>, cohortLabel: string | null): Pending {
  if (query.is_loading) return { kind: "loading" };
  return query.is_error ? { kind: "error", cohort_label: cohortLabel } : { kind: "missing", cohort_label: cohortLabel };
}

/**
 * Reads the sibling as it stood when the viewed revision was written, so an
 * older revision is never set against a newer brief or result. A body `read`
 * rejects, or a sibling with no revision that early, counts as missing.
 */
export function selectCohortArtifactLookup<T>(sources: CohortArtifactSources, read: (body: unknown) => T | null): CohortArtifactLookup<T> {
  const missing = { kind: "missing", cohort_label: sources.cohort_label } as const;
  if (!sources.cohort_label) return missing;
  if (!sources.run.data) return selectPending(sources.run, sources.cohort_label);
  if (!sources.artifact_id) return missing;
  if (!sources.detail.data) return selectPending(sources.detail, sources.cohort_label);
  const revision = selectRevisionAsOf(sources.detail.data.revisions, sources.as_of);
  const value = revision ? read(revision.body) : null;
  return value === null ? missing : { kind: "found", value };
}
