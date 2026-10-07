import { useMemo } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { useCohortArtifact } from "../../hooks/useCohortArtifact";
import { parseAssessment } from "../../lib/assessment";
import { readBuildBrief } from "../../lib/build-brief";
import { readBuildResult } from "../../lib/build-result";
import { AssessmentViewer } from "../molecules/AssessmentViewer";

/** Loads the cohort's brief and build result, so the assessment reads against what was asked and what was built. */
export function AssessmentReview({ body, source }: ViewerProps) {
  const parsed = useMemo(() => parseAssessment(body), [body]);
  const cohortLabel = source?.label ?? null;
  const brief = useCohortArtifact({ source, cohort_label: cohortLabel, type_id: "dev.build_brief", read: readBuildBrief });
  const result = useCohortArtifact({ source, cohort_label: cohortLabel, type_id: "dev.build_result", read: readBuildResult });

  if (!parsed.ok) {
    return <div className="or-error" role="alert">This assessment does not match the registered contract ({parsed.error.field}: {parsed.error.detail}).</div>;
  }
  return <AssessmentViewer assessment={parsed.value} brief={brief} result={result} cohortLabel={cohortLabel} />;
}
