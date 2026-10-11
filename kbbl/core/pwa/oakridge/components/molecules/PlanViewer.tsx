import { useState } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { selectCheckedField, selectFieldItems, selectFieldText } from "../../artifact-types";
import { selectPlanGraph } from "../../lib/plan-graph";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { PlanGraph } from "./PlanGraph";
import { PlanCohortCard } from "./PlanCohortCard";
import { ArtifactSection } from "./ArtifactSection";
import { RiskCard } from "./RiskCard";
export function PlanViewer({ body, schemas }: ViewerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layout = selectPlanGraph(body, schemas);
  return <article className="flex flex-col gap-4" data-testid="or-plan-viewer">
    <p>{selectFieldText(body, schemas, "summary")}</p>
    <PlanGraph layout={layout} selectedId={selectedId} onSelect={setSelectedId} />
    <ul>{layout.nodes.map((node) => <PlanCohortCard key={node.id} node={node} schemas={schemas} isSelected={node.id === selectedId} />)}</ul>
    <ArtifactSection title="Scope" testId="or-plan-scope"><OperatorTypedValue value={selectCheckedField(body, schemas, "scope") ?? body} schemas={schemas} /></ArtifactSection>
    <ArtifactSection title="Acceptance criteria" testId="or-plan-criteria"><OperatorTypedValue value={selectCheckedField(body, schemas, "acceptance_criteria") ?? body} schemas={schemas} /></ArtifactSection>
    <ArtifactSection title="Risks" testId="or-plan-risks">{selectFieldItems(body, schemas, "risks").map((risk, index) => <RiskCard key={index} risk={risk} schemas={schemas} />)}</ArtifactSection>
  </article>;
}
