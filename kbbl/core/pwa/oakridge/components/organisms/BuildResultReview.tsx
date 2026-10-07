import { useMemo } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { useArtifact } from "../../hooks/useArtifact";
import { useRun } from "../../hooks/useRun";
import { parseBuildResult, selectCohortBriefArtifactId, selectCohortBriefLookup } from "../../lib/build-result";
import { BuildResultViewer } from "../molecules/BuildResultViewer";

/**
 * Loads the brief the build worked from, so the result can be read against it.
 * The run query is the one the workspace already polls, so this adds one
 * artifact fetch per review.
 */
export function BuildResultReview({ body, source }: ViewerProps) {
  const parsed = useMemo(() => parseBuildResult(body), [body]);
  const cohortLabel = source?.label ?? (parsed.ok ? parsed.value.delegated_session_metadata?.cohort_id ?? null : null);
  const runId = source?.run_id ?? "";
  const runQuery = useRun(runId, runId !== "" && cohortLabel !== null);
  const briefArtifactId = runQuery.data && cohortLabel ? selectCohortBriefArtifactId(runQuery.data, cohortLabel) : null;
  const briefQuery = useArtifact(briefArtifactId ?? "", briefArtifactId !== null);

  if (!parsed.ok) {
    return <div className="or-error" role="alert">This build result does not match the registered contract ({parsed.error.field}: {parsed.error.detail}).</div>;
  }
  const brief = selectCohortBriefLookup({
    cohort_label: cohortLabel,
    run: runQuery.data,
    is_run_pending: runQuery.isLoading,
    brief_artifact_id: briefArtifactId,
    brief_detail: briefQuery.data,
    is_brief_pending: briefQuery.isLoading,
  });
  return <BuildResultViewer result={parsed.value} brief={brief} cohortLabel={cohortLabel} />;
}
