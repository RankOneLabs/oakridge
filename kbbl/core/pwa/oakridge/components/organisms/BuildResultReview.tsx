import { useMemo } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { useCohortArtifact } from "../../hooks/useCohortArtifact";
import { readBuildBrief } from "../../lib/build-brief";
import { parseBuildResult } from "../../lib/build-result";
import { BuildResultViewer } from "../molecules/BuildResultViewer";

/** Loads the brief the build worked from, so the result can be read against it. */
export function BuildResultReview({ body, source }: ViewerProps) {
  const parsed = useMemo(() => parseBuildResult(body), [body]);
  const cohortLabel = source?.label ?? (parsed.ok ? parsed.value.delegated_session_metadata?.cohort_id ?? null : null);
  const brief = useCohortArtifact({ source, cohort_label: cohortLabel, type_id: "dev.build_brief", read: readBuildBrief });

  if (!parsed.ok) {
    return <div className="or-error" role="alert">This build result does not match the registered contract ({parsed.error.field}: {parsed.error.detail}).</div>;
  }
  return <BuildResultViewer result={parsed.value} brief={brief} cohortLabel={cohortLabel} />;
}
