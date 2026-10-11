import type { ViewerProps } from "../../artifactRegistry";
import { selectCheckedField, selectFieldText } from "../../artifact-types";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { ArtifactSection } from "./ArtifactSection";
import { selectOrderedCheckedIssues } from "../../lib/build-result";
export function BuildResultViewer({ body, schemas }: ViewerProps) {
  return <article className="flex flex-col gap-4" data-testid="or-build-result-viewer"><p>{selectFieldText(body, schemas, "summary")}</p>
    {(["changed_files", "tests"] as const).map((key) => <ArtifactSection key={key} title={key.replaceAll("_", " ")} testId={`or-build-${key}`}>
      <OperatorTypedValue value={selectCheckedField(body, schemas, key) ?? body} schemas={schemas} />
    </ArtifactSection>)}
    <ArtifactSection title="known issues" testId="or-build-known_issues"><ol>
      {selectOrderedCheckedIssues(body, schemas).map((issue, index) => <li key={index}><OperatorTypedValue value={issue} schemas={schemas} /></li>)}
    </ol></ArtifactSection>
  </article>;
}
