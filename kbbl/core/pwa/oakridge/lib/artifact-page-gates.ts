import type { ParkedGate } from "../artifact-types";

interface ArtifactPageGateInput {
  readonly gates: readonly ParkedGate[];
  readonly revision_ids: ReadonlySet<string>;
}

interface ArtifactPageGates {
  readonly artifactGate: ParkedGate | null;
  readonly adjudicationGate: ParkedGate | null;
}

export function selectArtifactPageGates({ gates, revision_ids }: ArtifactPageGateInput): ArtifactPageGates {
  return {
    artifactGate: gates.find(gate => gate.artifact_revision_id !== null && revision_ids.has(gate.artifact_revision_id)) ?? null,
    adjudicationGate: gates.find(gate => gate.assessment_revision_id != null && revision_ids.has(gate.assessment_revision_id)) ?? null,
  };
}
