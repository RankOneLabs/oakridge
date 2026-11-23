import { useMemo } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { useCohortArtifact } from "../../hooks/useCohortArtifact";
import { readBuildBrief } from "../../lib/build-brief";
import { asBuildSummary } from "../../lib/build-result";
import { StructuredValue } from "../molecules/StructuredValue";
import { BuildResultViewer } from "../molecules/BuildResultViewer";

/** Loads the brief the build worked from, so the result can be read against it. */
export function BuildResultReview({ body, source, onOpenTask, onOpenItem, itemGrading }: ViewerProps) {
  const result = useMemo(() => asBuildSummary(body), [body]);
  const cohortLabel = source?.label ?? result?.delegated_session_metadata?.cohort_id ?? null;
  const brief = useCohortArtifact({ source, cohort_label: cohortLabel, view: "build_brief", read: readBuildBrief });

  if (!result) return <StructuredValue value={body} />;
  return <BuildResultViewer result={result} brief={brief} cohortLabel={cohortLabel} briefReview={{ source: brief.kind === "found" ? brief.source : undefined, onOpenTask, onOpenItem, itemGrading }} />;
}
