import { useMemo } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { useCohortArtifact } from "../../hooks/useCohortArtifact";
import { parseAssessment } from "../../lib/assessment";
import { readBuildBrief } from "../../lib/build-brief";
import { readBuildResult } from "../../lib/build-result";
import { AssessmentViewer } from "../molecules/AssessmentViewer";
import { BuilderHandoffPanel } from "./BuilderHandoffPanel";

/** Loads the cohort's brief and build result, so the assessment reads against what was asked and what was built. */
export function AssessmentReview({ body, source, edit, gate }: ViewerProps) {
  const parsed = useMemo(() => parseAssessment(body), [body]);
  const isIntegration = source?.producing_stage === "integration";
  const cohortLabel = isIntegration ? null : source?.label ?? null;
  const brief = useCohortArtifact({ source, cohort_label: cohortLabel, type_id: "dev.build_brief", read: readBuildBrief });
  const result = useCohortArtifact({ source, cohort_label: cohortLabel, type_id: "dev.build_result", read: readBuildResult });

  if (!parsed.ok) {
    return <div className="or-error" role="alert">This assessment does not match the registered contract ({parsed.error.field}: {parsed.error.detail}).</div>;
  }
  if (!source) return <div className="or-error" role="alert">Assessment revision identity is unavailable.</div>;
  return <AssessmentViewer assessment={parsed.value} brief={brief} result={result} revisionScope={source.revision_id}
    cohortLabel={isIntegration ? source.label ?? null : cohortLabel} isIntegration={isIntegration}
    handoff={!isIntegration && cohortLabel && edit?.enabled && edit.onSubmitBody
      && parsed.value.recommended_next_actions.every((action) => typeof action !== "string")
      ? <BuilderHandoffPanel runId={source.run_id} unitLabel={cohortLabel} assessment={parsed.value} body={body as typeof parsed.value}
          gate={gate ?? null} edit={edit} />
      : undefined} />;
}
