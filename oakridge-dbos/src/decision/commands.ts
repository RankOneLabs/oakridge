import type { ArtifactEnvelope } from "../domain/execution";
import type { BlockedReason, CoreStatus, NextActor } from "../domain/records";
import type { ArtifactId, CohortId, JsonValue, RunRecordVersion, RunUnitId, StageInstanceId, WorkflowRunId, WorkOrderId } from "../domain/primitives";
import type { TransitionEffectDescriptor } from "../domain/run-record";
import type { StageOutcome } from "../domain/workflow";

/** Retained as the typed input-map boundary used by execution resolution. */
export type StageInputSet = Readonly<Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]>>;

export interface StatusChange {
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly outcome: JsonValue | null;
}

export type Command =
  | {
      readonly kind: "transition_run";
      readonly run_id: WorkflowRunId;
      readonly expected_version: RunRecordVersion;
      readonly change: StatusChange;
      readonly effect: TransitionEffectDescriptor;
    }
  | {
      readonly kind: "transition_stage";
      readonly run_id: WorkflowRunId;
      readonly stage_instance_id: StageInstanceId;
      readonly expected_version: number;
      readonly change: StatusChange;
      readonly effect: TransitionEffectDescriptor;
    }
  | {
      readonly kind: "transition_cohort";
      readonly run_id: WorkflowRunId;
      readonly cohort_id: CohortId;
      readonly expected_version: number;
      readonly change: StatusChange;
      readonly effect: TransitionEffectDescriptor;
      /** Opaque adapter state written with the projected core status. */
      readonly stage_data?: JsonValue;
    };

export type Contradiction =
  | { readonly kind: "duplicate_stage"; readonly stage_instance_id: StageInstanceId }
  | { readonly kind: "unknown_stage_dependency"; readonly stage_instance_id: StageInstanceId; readonly dependency_stage_instance_id: StageInstanceId };

export interface Derivation {
  /** One deterministic batch. Each command names the version of its own owner. */
  readonly commands: readonly Command[];
  /** Artifact identities used by the proof, useful for transition diagnostics. */
  readonly observed_artifact_ids: readonly ArtifactId[];
}

/** Compatibility boundary for callers that will move to the v15 topology in c8. */
export type AskResult =
  | { readonly kind: "complete"; readonly outcome: StageOutcome }
  | { readonly kind: "recheck"; readonly record_version: RunRecordVersion; readonly started: readonly { readonly id: WorkOrderId; readonly run_unit_id: RunUnitId }[] }
  | { readonly kind: "wait"; readonly record_version: RunRecordVersion };
