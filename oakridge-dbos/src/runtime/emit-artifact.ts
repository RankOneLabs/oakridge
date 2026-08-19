import { createHash, randomUUID } from "node:crypto";

import { releaseStateForArtifact, validateArtifactEmission } from "../contracts/evaluate-artifacts";
import type { ArtifactEmission, ArtifactReleaseState, ArtifactRevision } from "../domain/artifacts";
import { err, ok, type ArtifactId, type JsonValue, type Result, type StageInstanceId, type UnitId } from "../domain/primitives";
import type { ArtifactRevisionRepository, ExecutionArtifactContextRepository } from "../storage/repositories";

/**
 * Publishing one artifact against a live execution's contract.
 *
 * This used to live inside the HTTP route, which was fine while an agent over
 * HTTP was the only thing that could produce an artifact. A deterministic
 * executor produces one too, in process, and the alternative to sharing this
 * transform was for the backend to call its own HTTP surface — a second
 * emission path, differing in exactly the places (validation, release state,
 * notification) where a divergence would be invisible until a run stalled.
 */

export interface EmitExecutionArtifactDependencies {
  readonly contexts: ExecutionArtifactContextRepository;
  readonly artifacts: ArtifactRevisionRepository;
  dispatch_notifications(): Promise<number>;
}

export interface EmitExecutionArtifactRequest {
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  /** The executor claiming the emission, checked against the recorded execution. */
  readonly executor_type: string;
  readonly output_name: string;
  readonly body: JsonValue;
  /** Absent means "key on the payload", which makes an identical re-emission a replay. */
  readonly idempotency_key: string | null;
}

export type EmitExecutionArtifactFailure =
  | { readonly kind: "execution_not_found"; readonly detail: string }
  | { readonly kind: "unknown_output"; readonly detail: string }
  | { readonly kind: "contract_violation"; readonly detail: string }
  | { readonly kind: "emission_conflict"; readonly detail: string; readonly conflict: "idempotency_conflict" | "release_conflict" | "invariant_conflict" | "execution_closed"; readonly artifact_id: ArtifactId }
  | { readonly kind: "persistence_failed"; readonly detail: string };

export interface EmittedExecutionArtifact {
  readonly artifact: ArtifactRevision;
  readonly release: ArtifactReleaseState;
  readonly superseded_artifact_id: ArtifactId | null;
}

export const emitExecutionArtifact = async (
  dependencies: EmitExecutionArtifactDependencies,
  request: EmitExecutionArtifactRequest,
): Promise<Result<EmittedExecutionArtifact, EmitExecutionArtifactFailure>> => {
  const execution = await dependencies.contexts.find_for_emit(request.stage_instance_id, request.unit_id);
  if (!execution || execution.executor_type !== request.executor_type) {
    return err({ kind: "execution_not_found", detail: "execution unit not found" });
  }
  const declared = execution.outputs.find((output) => output.name === request.output_name);
  if (!declared) return err({ kind: "unknown_output", detail: `unknown output slot: ${request.output_name}` });
  const payloadHash = createHash("sha256").update(JSON.stringify(request.body)).digest("hex");
  const emission: ArtifactEmission = {
    run_id: execution.run_id, stage_instance_id: execution.stage_instance_id, execution_id: execution.execution_id,
    unit_id: execution.unit_id, output_name: declared.name, artifact_type: declared.artifact_type, label: execution.unit_id,
    body: request.body, idempotency_key: request.idempotency_key ?? payloadHash, payload_hash: payloadHash,
  };
  const validation = validateArtifactEmission(emission, execution.outputs);
  if (!validation.ok) return err({ kind: "contract_violation", detail: validation.error.detail });
  let result;
  try {
    result = await dependencies.artifacts.emit_revision(randomUUID() as ArtifactId, emission, new Date().toISOString(),
      { target_workflow_id: execution.execution_workflow_id, release: validation.value.release });
  } catch (error) {
    return err({ kind: "persistence_failed", detail: error instanceof Error ? error.message : String(error) });
  }
  if (!result.ok) return err({ kind: "emission_conflict", detail: result.error.detail, conflict: result.error.kind, artifact_id: result.error.artifact_id });
  const artifact = result.value.artifact;
  await dependencies.dispatch_notifications();
  return ok({ artifact, release: releaseStateForArtifact(artifact, validation.value.release), superseded_artifact_id: result.value.superseded_artifact_id });
};
