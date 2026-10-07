import type { ArtifactDetail, RunDetail } from "../types";

/** Whether a sibling artifact for the same cohort could be read, and why not when it could not. */
export type CohortArtifactLookup<T> =
  | { kind: "loading" }
  | { kind: "missing"; cohort_label: string | null }
  | { kind: "found"; value: T };

/** The latest artifact of a type the run published for a cohort, or null when it has none. */
export function selectCohortArtifactId(run: RunDetail, typeId: string, cohortLabel: string): string | null {
  const matches = run.stages
    .flatMap((stage) => stage.artifacts)
    .filter((artifact) => artifact.type_id === typeId && artifact.label === cohortLabel);
  const latest = matches.reduce<(typeof matches)[number] | null>((best, artifact) => (best && best.version >= artifact.version ? best : artifact), null);
  return latest?.id ?? null;
}

export interface CohortArtifactSources {
  cohort_label: string | null;
  run: RunDetail | undefined;
  is_run_loading: boolean;
  artifact_id: string | null;
  detail: ArtifactDetail | undefined;
  is_detail_loading: boolean;
}

/** Reads the sibling's latest revision with `read`; a body `read` rejects counts as missing. */
export function selectCohortArtifactLookup<T>(sources: CohortArtifactSources, read: (body: unknown) => T | null): CohortArtifactLookup<T> {
  const missing = { kind: "missing", cohort_label: sources.cohort_label } as const;
  if (!sources.cohort_label) return missing;
  if (!sources.run) return sources.is_run_loading ? { kind: "loading" } : missing;
  if (!sources.artifact_id) return missing;
  if (!sources.detail) return sources.is_detail_loading ? { kind: "loading" } : missing;
  const latest = sources.detail.revisions.at(-1);
  const value = latest ? read(latest.body) : null;
  return value === null ? missing : { kind: "found", value };
}
