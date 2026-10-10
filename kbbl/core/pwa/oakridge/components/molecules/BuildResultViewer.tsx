import type { ViewerProps } from "../../artifactRegistry";
import { selectCheckedField, selectFieldText } from "../../artifact-types";
import { OperatorTypedValue } from "./OperatorTypedValue";
import { ArtifactSection } from "./ArtifactSection";
export function BuildResultViewer({ body, schemas }: ViewerProps) {
  return <article className="flex flex-col gap-4" data-testid="or-build-result-viewer"><p>{selectFieldText(body, schemas, "summary")}</p>
    {(["changed_files", "tests", "known_issues"] as const).map((key) => <ArtifactSection key={key} title={key.replaceAll("_", " ")} testId={`or-build-${key}`}>
      <OperatorTypedValue value={selectCheckedField(body, schemas, key) ?? body} schemas={schemas} />
    </ArtifactSection>)}
  </article>;
}
