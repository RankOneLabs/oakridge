import type { OperatorArtifactRevisionRecord } from "../../operator-contracts";
import { Chip } from "../../../components/atoms/Chip";

interface Props { readonly revision: OperatorArtifactRevisionRecord }
export function ArtifactRevisionNavigation({ revision }: Props) {
  return <nav className="or-artifact-detail__rev-nav" data-testid="or-revision-navigation">
    <Chip tone="accent" testId="or-rev-tab-0">Revision {revision.version}</Chip>
    <span>{new Date(revision.created_at).toLocaleString()}</span>
    {revision.predecessor_id && <small>Previous revision: {revision.predecessor_id}</small>}
  </nav>;
}
