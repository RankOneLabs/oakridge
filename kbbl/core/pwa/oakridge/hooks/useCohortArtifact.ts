import { selectCohortArtifactId, selectCohortArtifactLookup, type CohortArtifactLookup } from "../lib/cohort-artifact";
import type { ArtifactSource } from "../types";
import { useArtifact } from "./useArtifact";
import { useRun } from "./useRun";

export interface CohortArtifactQuery<T> {
  source: ArtifactSource | undefined;
  cohort_label: string | null;
  type_id: string;
  read: (body: unknown) => T | null;
}

/**
 * Loads another artifact the same run published for the same cohort, such as
 * a build result's brief, as it stood at the viewed revision. The run query is
 * the one the workspace already polls.
 */
export function useCohortArtifact<T>({ source, cohort_label, type_id, read }: CohortArtifactQuery<T>): CohortArtifactLookup<T> {
  const runId = source?.run_id ?? "";
  const runQuery = useRun(runId, runId !== "" && cohort_label !== null);
  const artifactId = runQuery.data && cohort_label ? selectCohortArtifactId(runQuery.data, type_id, cohort_label) : null;
  const artifactQuery = useArtifact(artifactId ?? "", artifactId !== null);
  if (!source) return { kind: "missing", cohort_label };
  // isLoading, not isPending: a disabled query stays pending forever.
  return selectCohortArtifactLookup({
    cohort_label,
    as_of: source.as_of,
    run: { data: runQuery.data, is_loading: runQuery.isLoading, is_error: runQuery.isError },
    artifact_id: artifactId,
    detail: { data: artifactQuery.data, is_loading: artifactQuery.isLoading, is_error: artifactQuery.isError },
  }, read);
}
