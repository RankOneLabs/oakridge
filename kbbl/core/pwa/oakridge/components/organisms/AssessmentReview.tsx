import { useMemo } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { useCohortArtifact } from "../../hooks/useCohortArtifact";
import { parseAssessment } from "../../lib/assessment";
import { readBuildBrief } from "../../lib/build-brief";
import { readBuildResult } from "../../lib/build-result";
import { AssessmentViewer } from "../molecules/AssessmentViewer";
import { BuilderHandoffPanel } from "./BuilderHandoffPanel";

/** Loads the cohort's brief and build result, so the assessment reads against what was asked and what was built. */
export function AssessmentReview({ body, source, edit, gate, onOpenTask, onOpenItem, itemGrading }: ViewerProps) {
  const parsed = useMemo(() => parseAssessment(body), [body]);
  const isIntegration = source?.producing_stage === "integration";
  const cohortLabel = isIntegration ? null : source?.label ?? null;
  const brief = useCohortArtifact({ source, cohort_label: cohortLabel, type_id: "dev.build_brief", read: readBuildBrief });
  const result = useCohortArtifact({ source, cohort_label: cohortLabel, type_id: "dev.build_result", read: readBuildResult });

  if (!parsed.ok) {
    return <div className="or-error" role="alert">This assessment does not match the registered contract ({parsed.error.field}: {parsed.error.detail}).</div>;
  }
  if (!source) return <div className="or-error" role="alert">Assessment revision identity is unavailable.</div>;
  return <AssessmentViewer assessment={parsed.value} brief={brief} result={result}
    cohortLabel={isIntegration ? source.label ?? null : cohortLabel} isIntegration={isIntegration}
    source={source} onOpenTask={onOpenTask} onOpenItem={onOpenItem} itemGrading={itemGrading}
    handoff={!isIntegration && cohortLabel && edit?.enabled && edit.onSubmitBody
      && parsed.value.recommended_next_actions.every((action) => typeof action !== "string")
      ? <BuilderHandoffPanel runId={source.run_id} unitLabel={cohortLabel} revisionId={source.revision_id} assessment={parsed.value} body={body as typeof parsed.value}
          gate={gate ?? null} edit={edit} />
      : undefined} />;
}

import { parseCurrentAssessment } from "../../lib/assessment";
import { parseCurrentBrief } from "../../lib/current-contract";
import { CurrentAssessmentViewer } from "../molecules/AssessmentViewer";
import { CurrentBuilderHandoffPanel } from "./BuilderHandoffPanel";
import { useAssessmentHistory } from "../../hooks/useAssessmentHistory";
const readCurrentBrief = (body: unknown) => { const result = parseCurrentBrief(body); return result.ok ? result.value : null; };
export function CurrentAssessmentReview({ body, source, gate, itemGrading, onOpenItem }: ViewerProps) {
  const parsed = parseCurrentAssessment(body);
  const brief = useCohortArtifact({ source, cohort_label: source?.producing_stage === "integration" ? null : source?.label ?? null, type_id: "dev.build_brief", read: readCurrentBrief });
  const history = useAssessmentHistory(source?.run_id ?? "", source?.revision_id ?? "");
  if (!parsed.ok) return <p role="alert">This assessment does not match the current contract: {parsed.error.detail}</p>;
  if (!source) return <p role="alert">Assessment revision identity is unavailable.</p>;
  return <CurrentAssessmentViewer assessment={parsed.value} source={source} itemGrading={itemGrading} onOpenItem={onOpenItem}
    itemLabels={brief.kind === "found" ? brief.value.build_items.map(item => ({ id: item.id, label: item.instructions })) : []}
    handoff={<><CurrentBuilderHandoffPanel assessment={parsed.value} revisionId={source.revision_id} gate={gate ?? null} decisions={history.data ?? []} />
      {history.isError && <p role="alert">Recorded history could not be loaded: {history.error.message}</p>}</>} />;
}
