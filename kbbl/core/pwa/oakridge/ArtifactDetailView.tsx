import { useArtifact } from "./hooks";
import type { ArtifactRevision } from "./types";
import { formatRelative } from "../lib/time";

interface RevisionPanelProps {
  revision: ArtifactRevision;
}

function RevisionPanel({ revision }: RevisionPanelProps) {
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
      <div className="or-revision-panel__meta">
        <span className="or-label">Revision</span>
        <code className="or-code">{revision.id.slice(0, 8)}</code>
        <span className={`or-chip or-chip--${revision.status}`} data-testid="or-revision-status">
          {revision.status}
        </span>
        <span className="or-muted">{formatRelative(revision.created_at)}</span>
      </div>

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

interface ArtifactDetailViewProps {
  artifactId: string;
  onBack: () => void;
}

export function ArtifactDetailView({ artifactId, onBack }: ArtifactDetailViewProps) {
  const query = useArtifact(artifactId);

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
          <span className="or-label">Run</span>
          <span>{artifact.run_id.slice(0, 8)}</span>
        </div>
      </header>

      <section className="or-artifact-detail__revisions">
        <h3 className="or-section-title">Revisions ({artifact.revisions.length})</h3>
        {artifact.revisions.map((rev) => (
          <RevisionPanel key={rev.id} revision={rev} />
        ))}
        {artifact.revisions.length === 0 && (
          <div className="or-empty">No revisions.</div>
        )}
      </section>
    </div>
  );
}
