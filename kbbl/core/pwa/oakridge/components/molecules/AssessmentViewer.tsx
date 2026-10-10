import type { ViewerProps } from "../../artifactRegistry";
import { selectCheckedField, selectFieldText } from "../../artifact-types";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { ArtifactSection } from "./ArtifactSection";
import { StatusBadge } from "../atoms/StatusBadge";
export function AssessmentViewer({ body, schemas }: ViewerProps) {
  return <article className="flex flex-col gap-4" data-testid="or-assessment-viewer">
    <StatusBadge status={selectFieldText(body, schemas, "verdict") ?? "assessment"} />
    {(["findings", "test_evidence", "recommended_next_actions"] as const).map((key) => <ArtifactSection key={key} title={key.replaceAll("_", " ")} testId={`or-assessment-${key}`}>
      <OperatorTypedValue value={selectCheckedField(body, schemas, key) ?? body} schemas={schemas} />
    </ArtifactSection>)}
  </article>;
}
