/**
 * The pure decision layer's view of one run — everything `derive` needs to
 * compute the run's next commands, and nothing it does not. Loaded by
 * `load_run_snapshot` (storage layer, not this package) in one transaction
 * under `SELECT ... FOR UPDATE`.
 *
 * Amends spec §3.2: `released_artifacts` is dropped from `UnitSnapshot` —
 * nothing in `derive` needs a unit's own released artifacts, only the run's
 * `available_artifacts` (what downstream stages may consume).
 */
import type { CompiledWorkflowDefinition } from "../domain/compiled-workflow";
import type { ArtifactEnvelope } from "../domain/execution";
import type { InputFingerprint, JsonValue, RunUnitId, StageInstanceId, UnitId } from "../domain/primitives";
import type { RunOutputSlot, RunStage, UnitState, WorkflowRun, WorkOrder } from "../domain/run-record";
import type { Wait } from "../domain/wait";
import type { StageKey, StageOutcome } from "../domain/workflow";

export interface AvailableArtifact extends ArtifactEnvelope {
  readonly producer_stage_key: StageKey;
}

export interface StagePolicy {
  readonly max_parallel: number;
  readonly manual_admission: boolean;
}

export interface UnitSnapshot {
  readonly id: RunUnitId;
  readonly unit_id: UnitId;
  readonly parameters: JsonValue;
  readonly input_fingerprint: InputFingerprint;
  readonly state: UnitState;
  readonly admitted: boolean;
  /** Needed to propagate a failed/cancelled unit into a run outcome (spec §1 rule 6b/6c). */
  readonly outcome: StageOutcome | null;
  /** By unit_id; may name units with no row yet (an open collection's forward edge). */
  readonly depends_on: readonly UnitId[];
  /** Only slots with required=true. */
  readonly required_slots: readonly RunOutputSlot[];
  readonly open_waits: readonly Wait[];
  /** Every order of the unit, any state. */
  readonly work_orders: readonly WorkOrder[];
}

export interface StageSnapshot {
  readonly id: StageInstanceId;
  readonly stage_key: StageKey;
  readonly state: RunStage["state"];
  readonly materialization_closed: boolean;
  readonly policy: StagePolicy;
  readonly units: readonly UnitSnapshot[];
}

export interface RunSnapshot {
  readonly run: WorkflowRun;
  readonly definition: CompiledWorkflowDefinition;
  /** Only stages that have a stage_instance row. */
  readonly stages: readonly StageSnapshot[];
  readonly available_artifacts: readonly AvailableArtifact[];
}
