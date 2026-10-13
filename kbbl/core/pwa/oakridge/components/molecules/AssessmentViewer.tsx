import { useState } from "react";
import type { ViewerProps } from "../../artifactRegistry";
import { selectBodyField, selectFieldText } from "../../artifact-types";
import { selectAssessmentView } from "../../lib/assessment";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { ArtifactSection } from "./ArtifactSection";
import { StatusBadge } from "../atoms/StatusBadge";
import { Button } from "../../../components/atoms/Button";
export function AssessmentViewer({ body }: ViewerProps) {
  const [showMet, setShowMet] = useState(false);
  const assessment = selectAssessmentView(body);
  const verdict = selectFieldText(body, "verdict") ?? "assessment";
  const verdictLabel = `${verdict.charAt(0).toUpperCase()}${verdict.slice(1).replaceAll("_", " ")}`;
  return <article className="flex flex-col gap-4" data-testid="or-assessment-viewer">
    <StatusBadge status={verdict} label={verdictLabel} testId="or-assessment-verdict" />
    <ArtifactSection title="findings" testId="or-assessment-findings">
      <div data-testid="or-assessment-attention"><ol>{assessment.needs_attention.map((finding, index) =>
        <li key={index}><OperatorTypedValue value={finding} /></li>)}</ol></div>
      {assessment.met.length > 0 && <><Button variant="secondary" aria-expanded={showMet} onClick={() => setShowMet((visible) => !visible)}>
        {showMet ? "Hide" : "Show"} met criteria ({assessment.met.length})
      </Button>{showMet && <ol>{assessment.met.map((finding, index) => <li key={index}><OperatorTypedValue value={finding} /></li>)}</ol>}</>}
      <p>{assessment.status_counts.map((entry) => `${entry.status}: ${entry.count}`).join(" · ")}</p>
    </ArtifactSection>
    {(["test_evidence", "recommended_next_actions"] as const).map((key) => <ArtifactSection key={key} title={key.replaceAll("_", " ")} testId={`or-assessment-${key}`}>
      <OperatorTypedValue value={selectBodyField(body, key)} />
    </ArtifactSection>)}
  </article>;
}
