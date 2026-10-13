import type { RunArtifact } from "../../lib/run-overview";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly artifacts: readonly RunArtifact[]; readonly onOpen: (revisionId: string) => void }
export function RunSidebarArtifacts({ artifacts, onOpen }: Props) {
  return <section data-testid="or-sidebar-artifacts"><h3>Artifacts</h3>
    {artifacts.length === 0 && <p>No artifacts published yet.</p>}
    <ul>{artifacts.map(({ artifact, revision }) => <li key={revision.id}>
      <Button variant="secondary" onClick={() => onOpen(revision.id)}>{artifact.artifact_key}</Button>
    </li>)}</ul>
  </section>;
}
