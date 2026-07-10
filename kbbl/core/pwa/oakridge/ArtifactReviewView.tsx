import { useState } from "react";
import { useArtifact } from "./hooks";
import { resolveViewer } from "./artifactRegistry";
import type { ArtifactRevision } from "./types";
import { formatRelative } from "../lib/time";

// JSON pretty-print fallback — retained from ArtifactDetailView
function JsonRevisionPanel({ revision }: { revision: ArtifactRevision }) {
  let bodyText: string;
  try {
    bodyText = JSON.stringify(revision.body, null, 2);
  } catch {
    bodyText = String(revision.body);
  }

  let validationText: string | null = null;
  if (revision.validation !== null && revision.validation !== undefined) {
    try {
      validationText = JSON.stringify(revision.validation, null, 2);
    } catch {
      validationText = String(revision.validation);
    }
  }

  return (
    <div className="or-revision-panel" data-testid="or-revision-panel">
      <div className="or-revision-panel__body">
        <span className="or-label">Body</span>
        <pre className="or-pre" data-testid="or-revision-body">{bodyText}</pre>
      </div>
      {validationText && (
        <div className="or-revision-panel__validation">
          <span className="or-label">Validation</span>
          <pre className="or-pre" data-testid="or-revision-validation">{validationText}</pre>
        </div>
      )}
    </div>
  );
}

interface ArtifactReviewViewProps {
  artifactId: string;
  onBack: () => void;
}

export function ArtifactReviewView({ artifactId, onBack }: ArtifactReviewViewProps) {
  const query = useArtifact(artifactId);
  const [selectedRevIdx, setSelectedRevIdx] = useState<number>(0);

  if (query.isError) {
    return (
      <div className="or-artifact-detail" data-testid="or-artifact-detail">
        <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>
        <div className="or-error" role="alert" data-testid="or-artifact-detail-error">
          {query.error instanceof Error ? query.error.message : "Failed to load artifact"}
        </div>
      </div>
    );
  }

  if (query.isPending || !query.data) {
    return (
      <div className="or-artifact-detail" data-testid="or-artifact-detail">
        <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>
        <div className="or-loading">Loading artifact…</div>
      </div>
    );
  }

  const artifact = query.data;
  const revisions = artifact.revisions;

  // Clamp selected index in case revisions changed since mount
  const revIdx = Math.min(selectedRevIdx, Math.max(0, revisions.length - 1));
  const revision = revisions[revIdx] as ArtifactRevision | undefined;

  // Resolve viewer: component_id → type_id → JSON fallback
  const Viewer =
    resolveViewer(artifact.component_id) ??
    resolveViewer(artifact.type_id) ??
    null;

  return (
    <div className="or-artifact-detail" data-testid="or-artifact-detail">
      <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>

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

      {revisions.length > 1 && (
        <nav className="or-artifact-detail__rev-nav">
          {revisions.map((rev, i) => (
            <button
              key={rev.id}
              type="button"
              className={`or-btn or-btn--sm ${i === revIdx ? "or-btn--primary" : "or-btn--secondary"}`}
              onClick={() => setSelectedRevIdx(i)}
              data-testid={`or-rev-tab-${i}`}
            >
              <span className={`or-chip or-chip--${rev.status}`}>{rev.status}</span>
              <span className="or-muted">{formatRelative(rev.created_at)}</span>
            </button>
          ))}
        </nav>
      )}

      {revision && (
        <section className="or-artifact-detail__revision">
          <div className="or-revision-panel__meta">
            <span className="or-label">Revision</span>
            <code className="or-code">{revision.id.slice(0, 8)}</code>
            <span className={`or-chip or-chip--${revision.status}`} data-testid="or-revision-status">
              {revision.status}
            </span>
            <span className="or-muted">{formatRelative(revision.created_at)}</span>
          </div>

          {Viewer ? (
            <Viewer body={revision.body} />
          ) : (
            <JsonRevisionPanel revision={revision} />
          )}
        </section>
      )}

      {revisions.length === 0 && (
        <div className="or-empty">No revisions.</div>
      )}
    </div>
  );
}
