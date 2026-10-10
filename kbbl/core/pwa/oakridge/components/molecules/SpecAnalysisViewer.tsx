import type { ViewerProps } from "../../artifactRegistry";
import { selectCheckedField, selectFieldItems, selectFieldText } from "../../artifact-types";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { ArtifactSection } from "./ArtifactSection";
import { RiskCard } from "./RiskCard";
export function SpecAnalysisViewer({ body, schemas }: ViewerProps) {
  const risks = selectFieldItems(body, schemas, "risks");
  return <article className="flex flex-col gap-4" data-testid="or-spec-analysis-viewer">
    <p>{selectFieldText(body, schemas, "summary")}</p>
    <ArtifactSection title="Source references" testId="or-spec-sources"><OperatorTypedValue value={selectCheckedField(body, schemas, "source_spec_refs") ?? body} schemas={schemas} /></ArtifactSection>
    <ArtifactSection title="Findings" testId="or-spec-findings"><OperatorTypedValue value={selectCheckedField(body, schemas, "findings") ?? body} schemas={schemas} /></ArtifactSection>
    <ArtifactSection title="Requirements" testId="or-spec-requirements"><OperatorTypedValue value={selectCheckedField(body, schemas, "requirements") ?? body} schemas={schemas} /></ArtifactSection>
    <ArtifactSection title={`Risks (${risks.length})`} testId="or-spec-risks">{risks.map((risk, index) => <RiskCard key={index} risk={risk} schemas={schemas} />)}</ArtifactSection>
  </article>;
}
