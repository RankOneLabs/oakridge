import { useEffect } from "react";
import type { ArtifactId } from "../../lib/ids";
import { formatRunWorkspaceHash, replaceHashRoute } from "../../lib/hash";
import { useArtifact } from "../hooks/useArtifact";
import { Button } from "../../components/atoms/Button";

interface Props { readonly artifactId: ArtifactId; readonly onBack: () => void }
export function ArtifactWorkspaceRedirectView({ artifactId, onBack }: Props) {
  const query = useArtifact(artifactId);
  const runId = query.data?.run_id ?? null;
  useEffect(() => { if (runId) replaceHashRoute(formatRunWorkspaceHash(runId, { kind: "artifact", artifact_id: artifactId })); }, [runId, artifactId]);
  return <main className="or-page" data-testid="or-artifact-redirect">
    {query.isPending && <p role="status">Locating artifact…</p>}
    {query.isError && <p role="alert">Could not locate artifact: {String(query.error)}</p>}
    {query.isSuccess && runId === null && <p role="status">This revision is absent from the available run projections.</p>}
    {runId && <p role="status">Opening the run workspace…</p>}
    <Button variant="secondary" onClick={onBack}>Back to runs</Button>
  </main>;
}
