import { useEffect } from "react";

import { useArtifact } from "../hooks/useArtifact";
import { formatRunWorkspaceHash, replaceHashRoute } from "../../lib/hash";
import type { ArtifactId } from "../../lib/ids";

interface ArtifactWorkspaceRedirectViewProps {
  artifactId: ArtifactId;
  onBack: () => void;
}

/**
 * `#oakridge/artifact/:id` resolved to its run via `ArtifactDetail.run_id` and
 * replaced with the canonical in-workspace form, so every existing deep link
 * keeps resolving and both legacy shapes converge on one URL.
 */
export function ArtifactWorkspaceRedirectView({
  artifactId,
  onBack,
}: ArtifactWorkspaceRedirectViewProps) {
  const query = useArtifact(artifactId);
  const runId = query.data?.run_id ?? null;

  useEffect(() => {
    if (runId === null) return;
    replaceHashRoute(formatRunWorkspaceHash(runId, { kind: "artifact", artifact_id: artifactId }));
  }, [runId, artifactId]);

  if (query.isError) {
    return (
      <div className="or-page" data-testid="or-artifact-redirect">
        <div
          className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
          role="alert"
          data-testid="or-artifact-redirect-error"
        >
          {query.error instanceof Error ? query.error.message : "Failed to load artifact"}
        </div>
        <div>
          <button type="button" className="or-shell__back" onClick={onBack}>
            Back to runs
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="or-page" data-testid="or-artifact-redirect">
      <div className="py-6 text-sm text-[var(--text-muted)]">
        {runId === null ? "Locating artifact…" : "Opening the run workspace…"}
      </div>
    </div>
  );
}
