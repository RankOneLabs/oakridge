import type { ArtifactId, AttemptId, CohortId, ExecutionId, JsonValue, SessionId, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "./primitives";
import { parseUuidId } from "./primitives";
import type { ArtifactTypeId } from "./workflow";

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

/** The immutable revision payload stored in oakridge.artifact. */
export interface ArtifactRecord {
  readonly id: ArtifactId;
  readonly chain_id: ArtifactId;
  readonly revision: number;
  readonly parent_artifact_id: ArtifactId | null;
  readonly artifact_type: ArtifactTypeId;
  readonly body: JsonValue;
  readonly label: string | null;
  readonly lifecycle: "current" | "superseded" | "withdrawn" | "released";
  readonly created_at: string;
}

/** Artifact ownership is separate from where it is accepted and how it arose. */
export interface ArtifactOwnerRecord {
  readonly artifact_id: ArtifactId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId | null;
  readonly cohort_id: CohortId | null;
}

/** The receiving stage and declared slot that accepted a revision. */
export interface ArtifactAcceptanceRecord {
  readonly artifact_id: ArtifactId;
  readonly run_id: WorkflowRunId;
  readonly receiving_stage_instance_id: StageInstanceId;
  readonly output_name: string;
  readonly artifact_type: ArtifactTypeId;
  readonly collection_key: import("./primitives").OutputCollectionKey | null;
  readonly accepted_at: string;
}

export type ArtifactProvenance =
  | { readonly kind: "stage_attempt"; readonly stage_instance_id: StageInstanceId; readonly attempt_id: AttemptId; readonly session_id: SessionId | null }
  | { readonly kind: "service_action"; readonly action: string }
  | { readonly kind: "operator_action"; readonly action: string }
  | { readonly kind: "import"; readonly source: JsonValue };

/** Named row type for oakridge.artifact_provenance. */
export type ArtifactProvenanceRecord = ArtifactProvenance & {
  readonly artifact_id: ArtifactId;
  readonly run_id: WorkflowRunId;
};
