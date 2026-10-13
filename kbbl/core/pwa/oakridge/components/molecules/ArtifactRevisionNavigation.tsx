import type { OperatorArtifactRevisionView } from "../../operator-contracts";
import { Chip } from "../../../components/atoms/Chip";

interface Props { readonly revision: OperatorArtifactRevisionView }
export function ArtifactRevisionNavigation({ revision }: Props) {
  return <nav className="or-artifact-detail__rev-nav" data-testid="or-revision-navigation">
    <Chip tone="accent" testId="or-rev-tab-0">Revision {revision.number}</Chip>
    <span>{new Date(revision.created_at).toLocaleString()}</span>
    {revision.predecessor_id && <small>Previous revision: {revision.predecessor_id}</small>}
  </nav>;
}
