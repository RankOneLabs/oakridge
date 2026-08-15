import type { ArtifactId, ExecutionId, JsonValue, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";
import type { ArtifactTypeId } from "./workflow";

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
  readonly created_at: string;
}

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

export type ArtifactReleaseState =
  | { readonly kind: "released"; readonly artifact: ArtifactRevision }
  | { readonly kind: "waiting_gate"; readonly artifact: ArtifactRevision; readonly gate_steps: readonly { readonly type: string; readonly actions: readonly string[] }[] }
  | { readonly kind: "waiting_handoff"; readonly artifact: ArtifactRevision; readonly downstream_role: string; readonly external_wait_kind: string };

export type ExecutionContractState =
  | { readonly kind: "waiting_artifacts"; readonly missing_outputs: readonly string[] }
  | { readonly kind: "satisfied"; readonly artifacts: readonly ArtifactRevision[] };
