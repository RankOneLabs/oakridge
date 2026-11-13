import type { ArtifactDetail } from "../../artifact-types";
interface ArtifactReviewHeaderProps {
  readonly artifact: ArtifactDetail;
}
export function ArtifactReviewHeader({ artifact }: ArtifactReviewHeaderProps) {
  return (
      <header className="or-artifact-detail__header">
        <h2 className="or-artifact-detail__title" data-testid="or-artifact-type">
          {artifact.type_id}
        </h2>
        <div className="or-artifact-detail__meta">
          <span className="or-label">Stage</span>
          <span data-testid="or-artifact-stage">{artifact.producing_stage}</span>
          {artifact.label && (
            <>
              <span className="or-label">Unit</span>
              <code className="or-code" data-testid="or-artifact-unit-label">{artifact.label}</code>
            </>
          )}
          <span className="or-label">Run</span>
          <span>{artifact.run_id.slice(0, 8)}</span>
          {artifact.component_id && (
            <>
              <span className="or-label">Component</span>
              <code className="or-code">{artifact.component_id}</code>
            </>
          )}
        </div>
      </header>
  );

}
