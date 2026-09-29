import type { BlockedReason, CoreStatus, NextActor } from "../domain/records";
import type { ArtifactId, CohortId, JsonValue, RunRecordVersion, StageInstanceId, WorkflowRunId } from "../domain/primitives";

/** Adapter output committed before core takes its decision snapshot. */
export interface CohortSnapshot {
  readonly id: CohortId;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly durable_version: number;
  readonly accepted_artifact_ids: readonly ArtifactId[];
  readonly outcome: JsonValue | null;
}

export interface StageSnapshot {
  readonly id: StageInstanceId;
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly durable_version: number;
  /** Stage identities are adapter-decoded and committed; core never reads their source bodies. */
  readonly dependency_stage_instance_ids: readonly StageInstanceId[];
  readonly accepted_artifact_ids: readonly ArtifactId[];
  readonly cohorts: readonly CohortSnapshot[];
  readonly outcome: JsonValue | null;
}

export interface RunDecisionSnapshot {
  readonly id: WorkflowRunId;
  readonly status: CoreStatus;
  readonly record_version: RunRecordVersion;
  readonly outcome: JsonValue | null;
}

/** The complete committed view read inside one decide transaction. */
export interface RunSnapshot {
  readonly run: RunDecisionSnapshot;
  readonly stages: readonly StageSnapshot[];
}
