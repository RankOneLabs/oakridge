import type { ArtifactTypeDescriptor } from "../artifact-types";
import type { OperatorArtifactView } from "../operator-contracts/projections/unit-view";

export function artifactType(stage: string | null, artifact: Pick<OperatorArtifactView, "artifact_key" | "view" | "is_reviewable" | "is_editable">): ArtifactTypeDescriptor {
  return {
    id: [stage, artifact.artifact_key].filter(Boolean).join("."),
    component_id: artifact.view ?? "",
    capabilities: {
      reviewable: artifact.is_reviewable,
      commentable: true,
      atom_editable: artifact.is_editable,
      review_items: true,
    },
    anchor_schema: null,
  };
}
