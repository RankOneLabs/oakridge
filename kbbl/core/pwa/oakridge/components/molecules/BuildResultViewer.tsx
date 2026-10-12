import type { ViewerProps } from "../../artifactRegistry";
import { selectBodyField, selectFieldText } from "../../artifact-types";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { ArtifactSection } from "./ArtifactSection";
import { selectOrderedCheckedIssues } from "../../lib/build-result";
export function BuildResultViewer({ body }: ViewerProps) {
  return <article className="flex flex-col gap-4" data-testid="or-build-result-viewer"><p>{selectFieldText(body, "summary")}</p>
    {(["changed_files", "tests"] as const).map((key) => <ArtifactSection key={key} title={key.replaceAll("_", " ")} testId={`or-build-${key}`}>
      <OperatorTypedValue value={selectBodyField(body, key) ?? body} />
    </ArtifactSection>)}
    <ArtifactSection title="known issues" testId="or-build-known_issues"><ol>
      {selectOrderedCheckedIssues(body).map((issue, index) => <li key={index}><OperatorTypedValue value={issue} /></li>)}
    </ol></ArtifactSection>
  </article>;
}
