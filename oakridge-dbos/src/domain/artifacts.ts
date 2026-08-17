import type { ArtifactId, ExecutionId, JsonValue, Result, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";
import type { ArtifactTypeId } from "./workflow";
import type { CompiledGateStep, OutputReleaseContract } from "./compiled-workflow";

/**
 * Where an artifact sits in the run graph — the natural key of its revision
 * chain. `ArtifactRevision` satisfies it structurally, so a caller holding a
 * revision passes the revision itself rather than unpacking four fields whose
 * order nothing checks.
 */
export interface ArtifactCoordinate {
  readonly stage_instance_id: StageInstanceId;
  readonly execution_id: ExecutionId;
  readonly unit_id: UnitId;
  readonly output_name: string;
}

export interface ArtifactRevision {
  readonly id: ArtifactId;
  readonly chain_id: ArtifactId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly execution_id: ExecutionId;
  readonly unit_id: UnitId;
  readonly output_name: string;
  readonly artifact_type: ArtifactTypeId;
  readonly label: string | null;
  readonly body: JsonValue;
  readonly version: number;
  readonly parent_artifact_id: ArtifactId | null;
  readonly lifecycle: ArtifactRevisionLifecycle;
  readonly created_at: string;
}

export type ArtifactRevisionLifecycle =
  | { readonly kind: "current" }
  | { readonly kind: "superseded"; readonly superseded_by_artifact_id: ArtifactId }
  | { readonly kind: "withdrawn"; readonly actor: string; readonly reason: string; readonly withdrawn_at: string }
  | { readonly kind: "released"; readonly released_at: string };

export type EmitArtifactRevisionResult = Result<{
  readonly kind: "emitted" | "unchanged";
  readonly artifact: ArtifactRevision;
  readonly superseded_artifact_id: ArtifactId | null;
}, {
  readonly operation: "emit_artifact_revision";
  readonly kind: "idempotency_conflict" | "release_conflict" | "invariant_conflict" | "execution_closed";
  readonly artifact_id: ArtifactId;
  readonly detail: string;
}>;

export interface WithdrawArtifactRequest {
  readonly artifact_id: ArtifactId;
  readonly actor: string;
  readonly reason: string;
  readonly withdrawn_at: string;
  readonly target_workflow_id: string;
}

export type WithdrawArtifactResult =
  | { readonly kind: "withdrawn"; readonly artifact: ArtifactRevision }
  | { readonly kind: "already_withdrawn"; readonly artifact: ArtifactRevision }
  | { readonly kind: "not_found"; readonly artifact_id: ArtifactId }
  | { readonly kind: "not_current"; readonly artifact_id: ArtifactId; readonly current_artifact_id: ArtifactId | null }
  | { readonly kind: "release_conflict"; readonly artifact_id: ArtifactId; readonly released_at: string };

export type ReleaseArtifactResult =
  | { readonly kind: "released"; readonly artifact: ArtifactRevision }
  | { readonly kind: "already_released"; readonly artifact: ArtifactRevision }
  | { readonly kind: "not_current"; readonly artifact_id: ArtifactId };

export interface ArtifactEmission {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly execution_id: ExecutionId;
  readonly unit_id: UnitId;
  readonly output_name: string;
  readonly artifact_type: ArtifactTypeId;
  readonly label: string | null;
  readonly body: JsonValue;
  readonly idempotency_key: string;
  readonly payload_hash: string;
}

export interface ArtifactEmissionDelivery {
  readonly target_workflow_id: string;
  readonly release: OutputReleaseContract;
}

export type ArtifactReleaseState =
  | { readonly kind: "released"; readonly artifact: ArtifactRevision }
  | { readonly kind: "waiting_gate"; readonly artifact: ArtifactRevision; readonly gate_steps: readonly CompiledGateStep[] }
  | { readonly kind: "waiting_handoff"; readonly artifact: ArtifactRevision; readonly downstream_role: string; readonly external_wait_kind: string };

export type ArtifactLifecycleNotification =
  | { readonly kind: "artifact_emitted"; readonly release: ArtifactReleaseState }
  | { readonly kind: "artifact_replaced"; readonly invalidated_artifact_id: ArtifactId; readonly release: ArtifactReleaseState }
  | { readonly kind: "artifact_invalidated"; readonly artifact_id: ArtifactId; readonly output_name: string; readonly reason: "superseded" | "withdrawn"; readonly replacement_artifact_revision_id: ArtifactId | null };

export interface PendingArtifactNotification {
  readonly id: string;
  readonly target_workflow_id: string;
  readonly message: ArtifactLifecycleNotification;
  readonly idempotency_key: string;
}

export type ExecutionContractState =
  | { readonly kind: "waiting_artifacts"; readonly missing_outputs: readonly string[] }
  | { readonly kind: "satisfied"; readonly artifacts: readonly ArtifactRevision[] };
