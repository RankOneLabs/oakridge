import type { ViewerProps } from "../../artifactRegistry";
import { selectBodyField, selectFieldText } from "../../artifact-types";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { ArtifactSection } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";
export function BuildBriefViewer({ body }: ViewerProps) {
  return <article className="flex flex-col gap-4" data-testid="or-build-brief-viewer">
    <h3>{selectFieldText(body, "title") ?? "Build brief"}</h3><ExpandableText text={selectFieldText(body, "goal") ?? ""} />
    {(["files_in_scope", "decisions_made", "approaches_rejected", "acceptance_criteria"] as const).map((key) => <ArtifactSection key={key} title={key.replaceAll("_", " ")} testId={`or-brief-${key}`}>
      <OperatorTypedValue value={selectBodyField(body, key) ?? body} />
    </ArtifactSection>)}
    <p>Next action: {selectFieldText(body, "next_action")}</p>
  </article>;
}
