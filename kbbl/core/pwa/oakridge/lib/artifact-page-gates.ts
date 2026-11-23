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

export function selectArtifactDecisionCopy(gate: ParkedGate, assessmentGate: ParkedGate | null) {
  if (gate.gate_type === "merge") return {
    title: "Confirm the merge", description: "Verify the pull request is merged, then continue the run.",
  };
  if (gate === assessmentGate) return {
    title: "Request changes", description: `Describe what ${gate.producer_labels?.join(", ") || "the producer"} needs to change.`,
  };
  return { title: "Make your decision", description: "Approve this artifact or request specific changes." };
}
