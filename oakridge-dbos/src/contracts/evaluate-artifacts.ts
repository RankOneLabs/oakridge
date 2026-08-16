import type { ArtifactEmission, ArtifactReleaseState, ArtifactRevision, ExecutionContractState } from "../domain/artifacts";
import type { CompiledOutputContract } from "../domain/compiled-workflow";
import type { ExecutorTerminalObservation, ExpectedArtifactContract } from "../domain/execution";
import { err, ok, type Result, type UnitId } from "../domain/primitives";

export interface ArtifactContractError {
  readonly operation: "evaluate_artifact_contract";
  readonly output_name: string;
  readonly detail: string;
}

export const validateArtifactEmission = (emission: ArtifactEmission, outputs: readonly CompiledOutputContract[]): Result<CompiledOutputContract, ArtifactContractError> => {
  const output = outputs.find((candidate) => candidate.name === emission.output_name);
  if (!output) return err({ operation: "evaluate_artifact_contract", output_name: emission.output_name, detail: "output is not declared by the stage contract" });
  if (output.artifact_type !== emission.artifact_type) return err({ operation: "evaluate_artifact_contract", output_name: emission.output_name, detail: `expected artifact type '${output.artifact_type}', received '${emission.artifact_type}'` });
  return ok(output);
};

export const releaseStateForArtifact = (artifact: ArtifactRevision, output: CompiledOutputContract): ArtifactReleaseState => {
  if (output.release.kind === "gate") return { kind: "waiting_gate", artifact, gate_steps: output.release.steps };
  if (output.release.kind === "handoff") return { kind: "waiting_handoff", artifact, downstream_role: output.release.downstream_role, external_wait_kind: output.release.external_wait_kind };
  return { kind: "released", artifact };
};

/**
 * An artifact_collection execution emits many artifacts under one output name,
 * one per collection id, so release state is only unique per unit and output.
 * Contract evaluation and release bookkeeping must agree on this key: keying
 * bookkeeping by output name alone drops a collection's already-released
 * siblings and the contract can never be satisfied again.
 */
export const artifactReleaseKey = (artifact: { readonly unit_id: UnitId; readonly output_name: string }): string => `${artifact.unit_id}:${artifact.output_name}`;

export const withoutReleaseFor = (releases: readonly ArtifactReleaseState[], artifact: ArtifactRevision): readonly ArtifactReleaseState[] =>
  releases.filter((candidate) => artifactReleaseKey(candidate.artifact) !== artifactReleaseKey(artifact));

export const withRelease = (releases: readonly ArtifactReleaseState[], artifact: ArtifactRevision): readonly ArtifactReleaseState[] =>
  [...withoutReleaseFor(releases, artifact), { kind: "released", artifact }];

export const evaluateExecutionArtifactContract = (outputs: readonly CompiledOutputContract[], releases: readonly ArtifactReleaseState[], expectedArtifacts?: readonly ExpectedArtifactContract[]): ExecutionContractState => {
  if (expectedArtifacts) {
    const released = new Map(releases.filter((release): release is Extract<ArtifactReleaseState, { kind: "released" }> => release.kind === "released").map((release) => [artifactReleaseKey(release.artifact), release.artifact]));
    const missing = expectedArtifacts.filter((expected) => !released.has(artifactReleaseKey(expected)));
    if (missing.length > 0) return { kind: "waiting_artifacts", missing_outputs: missing.map((expected) => artifactReleaseKey(expected)).sort() };
    return { kind: "satisfied", artifacts: expectedArtifacts.map((expected) => released.get(artifactReleaseKey(expected))).filter((artifact): artifact is ArtifactRevision => artifact !== undefined) };
  }
  const releasedByOutput = new Map(releases.filter((release): release is Extract<ArtifactReleaseState, { kind: "released" }> => release.kind === "released").map((release) => [release.artifact.output_name, release.artifact]));
  const missingOutputs = outputs.filter((output) => !releasedByOutput.has(output.name)).map((output) => output.name).sort();
  if (missingOutputs.length > 0) return { kind: "waiting_artifacts", missing_outputs: missingOutputs };
  return { kind: "satisfied", artifacts: outputs.map((output) => releasedByOutput.get(output.name)).filter((artifact): artifact is ArtifactRevision => artifact !== undefined) };
};

export const shouldAwaitArtifactRelease = (contract: ExecutionContractState, observation: ExecutorTerminalObservation): boolean =>
  contract.kind === "waiting_artifacts" && observation.kind === "succeeded";
