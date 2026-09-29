import type { ArtifactId, AttemptId, CohortId, JsonValue, OutputCollectionKey, SessionId, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";
import type { ArtifactTypeId } from "./workflow";

/**
 * Where an artifact sits in the run graph — the natural key of its revision
 * chain. `ArtifactRevision` satisfies it structurally, so a caller holding a
 * revision passes the revision itself rather than unpacking fields whose order
 * nothing checks.
 *
 * v15 keys a slot on the receiving stage and the declared output name
 * (`artifact_acceptance`), not on the execution that produced it: a retried
 * attempt fills the same slot, and keying on the producer made every retry look
 * like a new coordinate.
 */
export interface ArtifactCoordinate {
  readonly stage_instance_id: StageInstanceId;
  readonly output_name: string;
  readonly collection_key?: OutputCollectionKey | null;
}

/**
 * One revision, assembled from the four tables v15 splits an artifact across:
 * `artifact` (the immutable body and its chain), `artifact_owner` (whose
 * durable state contains it), `artifact_acceptance` (the receiving stage and
 * declared slot), and `artifact_provenance` (what produced it).
 */
export interface ArtifactRevision {
  readonly id: ArtifactId;
  readonly chain_id: ArtifactId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly cohort_id: CohortId | null;
  /** The cohort key the revision belongs to; `"0"` for a scalar stage. */
  readonly unit_id: UnitId;
  /** The attempt that produced it — absent for a service, operator or imported artifact. */
  readonly attempt_id: AttemptId | null;
  /** The agent session that produced it, when one had been ensured. */
  readonly session_id: SessionId | null;
  readonly output_name: string;
  readonly collection_key?: OutputCollectionKey | null;
  readonly artifact_type: ArtifactTypeId;
  readonly label: string | null;
  readonly body: JsonValue;
  readonly version: number;
  readonly parent_artifact_id: ArtifactId | null;
  readonly lifecycle: ArtifactRevisionLifecycle;
  readonly created_at: string;
}

/**
 * `oakridge.artifact.lifecycle`, with the one fact the bare enum cannot carry:
 * which revision superseded this one. That is read off the chain
 * (`parent_artifact_id = id`) rather than stored twice.
 */
export type ArtifactRevisionLifecycle =
  | { readonly kind: "current" }
  | { readonly kind: "superseded"; readonly superseded_by_artifact_id: ArtifactId | null }
  | { readonly kind: "withdrawn" }
  | { readonly kind: "released" };

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
  readonly collection_key: OutputCollectionKey | null;
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
