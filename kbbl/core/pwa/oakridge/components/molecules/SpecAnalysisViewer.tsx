import { useState } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { selectBodyField, selectFieldItems, selectFieldText } from "../../artifact-types";
import { selectCheckedSpecAnalysisView } from "../../lib/spec-analysis";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { ArtifactSection } from "./ArtifactSection";
import { RiskCard } from "./RiskCard";
import { Button } from "../../../components/atoms/Button";
import { ExpandableText } from "./ExpandableText";
export function SpecAnalysisViewer({ body }: ViewerProps) {
  const [showSources, setShowSources] = useState(false);
  const analysis = selectCheckedSpecAnalysisView(body);
  const sources = selectFieldItems(body, "source_spec_refs");
  const risks = selectFieldItems(body, "risks");
  return <article className="flex flex-col gap-4" data-testid="or-spec-analysis-viewer">
    <ExpandableText text={selectFieldText(body, "summary") ?? ""} />
    {analysis.blockers.length > 0 ? <ArtifactSection title="Blocking issues" testId="or-spec-blockers"><ol>
      {analysis.blockers.map((blocker, index) => <li key={index}><OperatorTypedValue value={blocker.value} /></li>)}
    </ol></ArtifactSection> : <p data-testid="or-spec-no-blockers">Nothing is blocking.</p>}
    <ArtifactSection title="Source references" testId="or-spec-sources">
      <Button variant="secondary" aria-expanded={showSources} onClick={() => setShowSources((visible) => !visible)}>
        {showSources ? "Hide" : "Show"} {sources.length} {sources.length === 1 ? "source" : "sources"}
      </Button>
      {showSources && <OperatorTypedValue value={selectBodyField(body, "source_spec_refs") ?? body} />}
    </ArtifactSection>
    <ArtifactSection title="Findings" testId="or-spec-findings"><ol>
      {analysis.findings.map((finding, index) => <li key={index}><OperatorTypedValue value={finding} /></li>)}
    </ol></ArtifactSection>
    <ArtifactSection title="Requirements" testId="or-spec-requirements"><ol>
      {analysis.requirements.map((requirement, index) => <li key={index}><OperatorTypedValue value={requirement} /></li>)}
    </ol></ArtifactSection>
    <p>{analysis.status_counts.map((entry) => `${entry.status}: ${entry.count}`).join(" · ")}</p>
    <ArtifactSection title={`Risks (${risks.length})`} testId="or-spec-risks">{risks.map((risk, index) => <RiskCard key={index} risk={risk} />)}</ArtifactSection>
  </article>;
}
