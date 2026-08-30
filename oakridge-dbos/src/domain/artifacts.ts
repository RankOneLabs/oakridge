import type { ArtifactId, ExecutionId, JsonValue, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "./primitives";
import { parseUuidId } from "./primitives";
import type { ArtifactTypeId } from "./workflow";
import type { CompiledGateStep, GateRevisionTarget } from "./compiled-workflow";

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
  readonly collection_key?: import("./primitives").OutputCollectionKey | null;
}

export interface ArtifactRevision {
  readonly collection_key?: import("./primitives").OutputCollectionKey | null;
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

/**
 * The work order that produced this revision, if any.
 *
 * v2's `publish_artifact` (`postgres-run-record.ts:890-894`) writes the work
 * order id into `artifact.execution_id` wherever v1 wrote a legacy execution
 * id — the shared `artifact` table was never given a second column for it. A
 * value that does not parse as a uuid is a pre-cutover (v1) row, not a v2
 * work order.
 */
export const workOrderIdOfArtifact = (artifact: ArtifactRevision): WorkOrderId | null => parseUuidId<WorkOrderId>(artifact.execution_id);

export interface ArtifactEmission {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly execution_id: ExecutionId;
  readonly unit_id: UnitId;
  readonly output_name: string;
  readonly collection_key?: import("./primitives").OutputCollectionKey | null;
  readonly artifact_type: ArtifactTypeId;
  readonly label: string | null;
  readonly body: JsonValue;
  readonly idempotency_key: string;
  readonly payload_hash: string;
}

export type ArtifactReleaseState =
  | { readonly kind: "released"; readonly artifact: ArtifactRevision }
  | {
      readonly kind: "waiting_gate";
      readonly artifact: ArtifactRevision;
      readonly gate_steps: readonly CompiledGateStep[];
      /**
       * Optional only because this shape is persisted in the command outbox: a
       * row written before this field existed carries no value, and a run in
       * flight across the deploy must not fail to parse. Default to
       * `"self_stage"` when absent — the pre-field behaviour.
       */
      readonly revision_target?: GateRevisionTarget;
    }
  | { readonly kind: "waiting_handoff"; readonly artifact: ArtifactRevision; readonly downstream_role: string; readonly external_wait_kind: string };

export type ExecutionContractState =
  | { readonly kind: "waiting_artifacts"; readonly missing_outputs: readonly string[] }
  | { readonly kind: "satisfied"; readonly artifacts: readonly ArtifactRevision[] };
