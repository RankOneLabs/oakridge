import type { ViewerProps } from "../../artifactRegistry";
import { useCohortArtifact } from "../../hooks/useCohortArtifact";
import { parseCurrentAssessment } from "../../lib/assessment";
import { parseCurrentBrief } from "../../lib/current-contract";
import { CurrentAssessmentViewer } from "../molecules/CurrentAssessmentViewer";

const readCurrentBrief = (body: unknown) => { const result = parseCurrentBrief(body); return result.ok ? result.value : null; };

export function CurrentAssessmentReview({ body, source, itemGrading, onOpenItem }: ViewerProps) {
  const parsed = parseCurrentAssessment(body);
  const brief = useCohortArtifact({ source, cohort_label: source?.producing_stage === "integration" ? null : source?.label ?? null, type_id: "dev.build_brief", read: readCurrentBrief });
  if (!parsed.ok) return <p role="alert">This assessment does not match the current contract. {parsed.error.detail}</p>;
  return <CurrentAssessmentViewer key={source?.revision_id} assessment={parsed.value} source={source} itemGrading={itemGrading} onOpenItem={onOpenItem}
    itemLabels={brief.kind === "found" ? brief.value.build_items.map(item => ({ id: item.id, label: item.instructions })) : []} />;
}
