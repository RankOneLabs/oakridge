/**
 * What `derive` may say, and the three ways it can prove a run cannot
 * proceed. Amends spec §3.3 (final): `Command.materialize_stage` drops
 * `stage_contract` (the storage layer already holds the compiled definition
 * and can look the contract up by `stage_key`); `materialize_unit` /
 * `revise_unit` gain `stage_key` and `inputs` — the named per-unit input map
 * — because `apply` must resolve slot bindings by input name, and
 * `input_snapshot` alone (its flattened envelopes) cannot answer "what is
 * input 'brief'".
 *
 * `StageInputSet` moves here from `compiler/select-unit-inputs.ts`, which is
 * deleted in the same PR — do not import it.
 */
import type { ArtifactEnvelope } from "../domain/execution";
import type { ArtifactId, InputFingerprint, JsonValue, RunRecordVersion, RunUnitId, StageInstanceId, UnitId, WorkOrderId } from "../domain/primitives";
import type { MaterializedRunOutput } from "../domain/run-record";
import type { StageKey, StageOutcome } from "../domain/workflow";
import type { StagePolicy } from "./snapshot";

export type StageInputSet = Readonly<Record<string, ArtifactEnvelope | readonly ArtifactEnvelope[]>>;

export type Command =
  | { readonly kind: "materialize_stage"; readonly stage_key: StageKey; readonly stage_instance_id: StageInstanceId; readonly policy: StagePolicy }
  | {
      readonly kind: "materialize_unit";
      readonly stage_key: StageKey;
      readonly stage_instance_id: StageInstanceId;
      readonly run_unit_id: RunUnitId;
      readonly unit_id: UnitId;
      readonly parameters: JsonValue;
      readonly depends_on: readonly UnitId[];
      readonly inputs: StageInputSet;
      readonly input_snapshot: readonly ArtifactEnvelope[];
      readonly input_fingerprint: InputFingerprint;
      readonly outputs: readonly MaterializedRunOutput[];
    }
  | {
      readonly kind: "revise_unit";
      readonly stage_key: StageKey;
      readonly stage_instance_id: StageInstanceId;
      readonly run_unit_id: RunUnitId;
      readonly unit_id: UnitId;
      readonly parameters: JsonValue;
      readonly inputs: StageInputSet;
      readonly input_snapshot: readonly ArtifactEnvelope[];
      readonly input_fingerprint: InputFingerprint;
    }
  | { readonly kind: "close_materialization"; readonly stage_key: StageKey; readonly stage_instance_id: StageInstanceId }
  | { readonly kind: "mark_unit_satisfied"; readonly run_unit_id: RunUnitId }
  | { readonly kind: "start_work"; readonly work_order_id: WorkOrderId; readonly run_unit_id: RunUnitId }
  | { readonly kind: "mark_stage_succeeded"; readonly stage_instance_id: StageInstanceId }
  | { readonly kind: "complete_run"; readonly outcome: StageOutcome };

export type Contradiction =
  | { readonly kind: "unknown_dependency_at_close"; readonly stage_key: StageKey; readonly unit_id: UnitId; readonly dependency: UnitId }
  | { readonly kind: "dependency_cycle"; readonly stage_key: StageKey; readonly cycle: readonly UnitId[] }
  /** `artifact_id` is null only when the fan-out drives over a non-input binding (repository provisioning fans out over run context). */
  | { readonly kind: "malformed_driver_artifact"; readonly stage_key: StageKey; readonly artifact_id: ArtifactId | null; readonly path: string; readonly detail: string };

export interface Derivation {
  /** One atomic batch, in application order; empty = nothing to do. */
  readonly commands: readonly Command[];
}

/** What `decide_run` (storage layer) returns to the root loop. Replaces `RunDecision`. */
export type AskResult =
  | { readonly kind: "complete"; readonly outcome: StageOutcome }
  | { readonly kind: "recheck"; readonly record_version: RunRecordVersion; readonly started: readonly { readonly id: WorkOrderId; readonly run_unit_id: RunUnitId }[] }
  | { readonly kind: "wait"; readonly record_version: RunRecordVersion };
