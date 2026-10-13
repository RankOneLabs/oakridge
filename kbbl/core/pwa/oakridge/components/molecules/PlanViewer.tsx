import { useState } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { selectBodyField, selectFieldItems, selectFieldText } from "../../artifact-types";
import { selectPlanGraph } from "../../lib/plan-graph";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { PlanGraph } from "./PlanGraph";
import { PlanCohortCard } from "./PlanCohortCard";
import { ArtifactSection } from "./ArtifactSection";
import { RiskCard } from "./RiskCard";
export function PlanViewer({ body }: ViewerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layout = selectPlanGraph(body);
  return <article className="flex flex-col gap-4" data-testid="or-plan-viewer">
    <p>{selectFieldText(body, "summary")}</p>
    <PlanGraph layout={layout} selectedId={selectedId} onSelect={setSelectedId} />
    <ul>{layout.nodes.map((node) => <PlanCohortCard key={node.id} node={node} isSelected={node.id === selectedId} />)}</ul>
    <ArtifactSection title="Scope" testId="or-plan-scope"><OperatorTypedValue value={selectBodyField(body, "scope")} /></ArtifactSection>
    <ArtifactSection title="Acceptance criteria" testId="or-plan-criteria"><OperatorTypedValue value={selectBodyField(body, "acceptance_criteria")} /></ArtifactSection>
    <ArtifactSection title="Risks" testId="or-plan-risks">{selectFieldItems(body, "risks").map((risk, index) => <RiskCard key={index} risk={risk} />)}</ArtifactSection>
  </article>;
}
