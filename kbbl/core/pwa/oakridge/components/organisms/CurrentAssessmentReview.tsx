import { useState } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import type { ParkedGate } from "../../artifact-types";
import { useAssessmentAdjudication } from "../../hooks/useAssessmentAdjudication";
import { useAssessmentHistory } from "../../hooks/useAssessmentHistory";
import { useCohortArtifact } from "../../hooks/useCohortArtifact";
import { parseCurrentAssessment } from "../../lib/assessment";
import { parseCurrentBrief } from "../../lib/current-contract";
import type { AssessmentItemLabel, CurrentAssessment } from "../../lib/current-assessment";
import type { OperatorRevisionDecision } from "../../operator-contracts/projections/unit-view";
import { CurrentAssessmentViewer } from "../molecules/CurrentAssessmentViewer";
import { AssessmentActionsPanel } from "./AssessmentActionsPanel";
import { AssessmentDecisionBar } from "./AssessmentDecisionBar";

const readCurrentBrief = (body: unknown) => { const result = parseCurrentBrief(body); return result.ok ? result.value : null; };

/** A current-contract assessment, with its open review's decisions above the sections. */
export function CurrentAssessmentReview({ body, source, gate, itemGrading, onOpenItem }: ViewerProps) {
  const parsed = parseCurrentAssessment(body);
  const brief = useCohortArtifact({ source, cohort_label: source?.producing_stage === "integration" ? null : source?.label ?? null, type_id: "dev.build_brief", read: readCurrentBrief });
  const history = useAssessmentHistory(source?.run_id ?? "", source?.revision_id ?? "");
  if (!parsed.ok) return <p role="alert">This assessment does not match the current contract: {parsed.error.detail}</p>;
  if (!source) return <p role="alert">Assessment revision identity is unavailable.</p>;
  return <>
    <AdjudicatedAssessment key={source.revision_id} assessment={parsed.value} revisionId={source.revision_id} gate={gate ?? null} decisions={history.data ?? []}
      itemLabels={brief.kind === "found" ? brief.value.build_items.map(item => ({ id: item.id, label: item.instructions })) : []}
      review={{ source, itemGrading, onOpenItem }} />
    {history.isError && <p role="alert">Recorded history could not be loaded: {history.error.message}</p>}
  </>;
}

interface AdjudicatedProps {
  assessment: CurrentAssessment;
  revisionId: string;
  gate: ParkedGate | null;
  decisions: readonly OperatorRevisionDecision[];
  itemLabels: readonly AssessmentItemLabel[];
  review: Pick<ViewerProps, "source" | "itemGrading" | "onOpenItem">;
}

/** Keyed by revision, so a new assessment starts a fresh adjudication. An open review opens on its actions, even when its gate loads late. */
function AdjudicatedAssessment({ assessment, revisionId, gate, decisions, itemLabels, review }: AdjudicatedProps) {
  const adjudication = useAssessmentAdjudication({ assessment, revisionId, gate, decisions });
  // Stays on actions once the review has been open, so recording a decision does not move the operator away.
  const [wasOpen, setWasOpen] = useState(adjudication.isOpen);
  if (adjudication.isOpen && !wasOpen) setWasOpen(true);
  return <CurrentAssessmentViewer assessment={assessment} itemLabels={itemLabels} {...review}
    initialSection={wasOpen ? "actions" : "items"}
    decisionBar={<AssessmentDecisionBar adjudication={adjudication} />}
    handoff={<AssessmentActionsPanel assessment={assessment} adjudication={adjudication} />} />;
}
