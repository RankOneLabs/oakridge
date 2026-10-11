import type { ViewerProps } from "../../artifactRegistry";
import { selectCheckedField, selectFieldText } from "../../artifact-types";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { ArtifactSection } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";
export function BuildBriefViewer({ body, schemas }: ViewerProps) {
  return <article className="flex flex-col gap-4" data-testid="or-build-brief-viewer">
    <h3>{selectFieldText(body, schemas, "title") ?? "Build brief"}</h3><ExpandableText text={selectFieldText(body, schemas, "goal") ?? ""} />
    {(["files_in_scope", "decisions_made", "approaches_rejected", "acceptance_criteria"] as const).map((key) => <ArtifactSection key={key} title={key.replaceAll("_", " ")} testId={`or-brief-${key}`}>
      <OperatorTypedValue value={selectCheckedField(body, schemas, key) ?? body} schemas={schemas} />
    </ArtifactSection>)}
    <p>Next action: {selectFieldText(body, schemas, "next_action")}</p>
  </article>;
}
