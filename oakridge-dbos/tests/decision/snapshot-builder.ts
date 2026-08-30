/**
 * A small builder so each `derive` test case reads as facts, not fixtures.
 * Every id is derived deterministically from `RUN_ID` via `src/decision/ids`,
 * exactly as production would compute it.
 */
import type { CompiledStageContract, CompiledWorkflowDefinition } from "../../src/domain/compiled-workflow";
import { fingerprintOf, runUnitIdFor, stableUuid, stageInstanceIdFor } from "../../src/decision/ids";
import type { AvailableArtifact, RunSnapshot, StagePolicy, StageSnapshot, UnitSnapshot } from "../../src/decision/snapshot";
import type { ArtifactId, InputFingerprint, JsonValue, OutputSlotVersion, RunRecordVersion, RunUnitId, StageInstanceId, UnitId, WaitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../../src/domain/primitives";
import type { RunOutputSlot, RunStage, UnitState, WorkflowRun, WorkOrder } from "../../src/domain/run-record";
import type { Wait } from "../../src/domain/wait";
import type { StageKey, StageOutcome } from "../../src/domain/workflow";

export const RUN_ID = "11111111-1111-4111-8111-111111111111" as WorkflowRunId;
export const NOW = "2026-08-29T12:00:00.000Z";
export const PRODUCER_STAGE_KEY = "brief_writer" as StageKey;
export const PRODUCER_OUTPUT_NAME = "brief";

const definitionId = "66666666-6666-4666-8666-666666666666" as WorkflowDefinitionId;

export const run = (options?: { readonly context?: JsonValue; readonly state?: WorkflowRun["state"]; readonly outcome?: StageOutcome | null; readonly record_version?: number }): WorkflowRun => ({
  id: RUN_ID, workflow_definition_id: definitionId, workflow_definition_version: 1,
  context: options?.context ?? {}, state: options?.state ?? "active", outcome: options?.outcome ?? null,
  record_version: (options?.record_version ?? 1) as RunRecordVersion, created_at: NOW, ended_at: null,
});

export const emptyDefinition = (): CompiledWorkflowDefinition => ({ stages: {}, edges: [], source_stages: [] });

/** One stage per key, `scalar` materialization — enough for run-completion (§D) tests that only care about stage membership. */
export const scalarStageDefinition = (stage_keys: readonly string[]): CompiledWorkflowDefinition => ({
  stages: Object.fromEntries(stage_keys.map((key): [string, CompiledStageContract] => [key, {
    stage_key: key as StageKey, stage_type: "delegated_session", operator_role: null, inputs: [], outputs: [],
    materialization: { kind: "scalar" }, executor: { executor_type: "delegated_session", definition_config: {} },
  }])),
  edges: [], source_stages: stage_keys as StageKey[],
});

/**
 * A fan-out consumer at `stage_key`, driven over a `unit_complete` edge from a
 * `brief_writer` producer — the dev-flow `build` shape spec §4 describes. The
 * driver item shape is `{ unit_id: artifact.unit_id, artifact: artifact.body }`
 * (`resolveBindingValue`'s `inputBindingValue`), so `unit_id_path` is `/unit_id`
 * and `depends_on_path` is `/artifact/depends_on`.
 *
 * `brief_writer` is deliberately NOT a key of `definition.stages`: `derive`'s
 * materialization loop (§B) only visits definition stages, and every
 * producer-side fact it needs — readiness, closure — comes from
 * `available_artifacts` and an optional `StageSnapshot` row, both independent
 * of the definition. A test that wants `brief_writer` "finished" stores that
 * row directly (`stage({ stage_key: PRODUCER_STAGE_KEY, materialization_closed: true, units: [...] })`);
 * one that wants the collection "open" simply never stores it.
 */
export const fanOutDefinition = (options: { readonly stage_key: string; readonly over_input: string; readonly max_parallel?: number; readonly manual_admission?: boolean }): CompiledWorkflowDefinition => {
  const consumer: CompiledStageContract = {
    stage_key: options.stage_key as StageKey, stage_type: "delegated_session", operator_role: "build",
    inputs: [{ name: options.over_input, artifact_type: "dev.brief", optional: false, collect: true, delivery: "unit_complete" }],
    outputs: [{ name: "result", artifact_type: "dev.build_result", release: { kind: "immediate" } }],
    materialization: { kind: "fan_out", over: { from: "input", input_name: options.over_input }, unit_id_path: "/unit_id", depends_on_path: "/artifact/depends_on",
      max_parallel: options.max_parallel ?? 1, manual_admission: options.manual_admission ?? false },
    executor: { executor_type: "delegated_session", definition_config: {} },
  };
  return {
    stages: { [options.stage_key]: consumer },
    edges: [{ producer_stage: PRODUCER_STAGE_KEY, producer_output: PRODUCER_OUTPUT_NAME, consumer_stage: options.stage_key as StageKey, consumer_input: options.over_input, delivery: "unit_complete" }],
    source_stages: [],
  };
};

/** The `run_unit_id` `derive` computes for `(stage_key, unit_id)` — the same one `unit()` gives that unit's `id`. */
export const runUnitIdForTest = (stage_key: string, unit_id: string): RunUnitId => runUnitIdFor(RUN_ID, stage_key as StageKey, unit_id as UnitId);

export const stage = (options: {
  readonly stage_key: string; readonly state?: RunStage["state"]; readonly materialization_closed?: boolean;
  readonly max_parallel?: number; readonly manual_admission?: boolean; readonly units?: readonly UnitSnapshot[];
}): StageSnapshot => ({
  id: stageInstanceIdFor(RUN_ID, options.stage_key as StageKey), stage_key: options.stage_key as StageKey,
  state: options.state ?? "active", materialization_closed: options.materialization_closed ?? false,
  policy: { max_parallel: options.max_parallel ?? 1, manual_admission: options.manual_admission ?? false } satisfies StagePolicy,
  units: options.units ?? [],
});

export const unit = (options: {
  readonly stage_key: string; readonly unit_id: string; readonly state?: UnitState; readonly admitted?: boolean;
  readonly outcome?: StageOutcome | null; readonly depends_on?: readonly string[]; readonly parameters?: JsonValue;
  readonly input_fingerprint?: string; readonly required_slots?: readonly RunOutputSlot[]; readonly open_waits?: readonly Wait[];
  readonly work_orders?: readonly WorkOrder[];
}): UnitSnapshot => ({
  id: runUnitIdFor(RUN_ID, options.stage_key as StageKey, options.unit_id as UnitId),
  unit_id: options.unit_id as UnitId, parameters: options.parameters ?? {},
  input_fingerprint: (options.input_fingerprint ?? "fingerprint") as InputFingerprint,
  state: options.state ?? "ready", admitted: options.admitted ?? true, outcome: options.outcome ?? null,
  depends_on: (options.depends_on ?? []) as UnitId[],
  // Defaults to one un-released slot: a real unit always carries at least one output, and an
  // empty array would trivially satisfy `.every(released)` and mis-fire `mark_unit_satisfied`.
  required_slots: options.required_slots ?? [emptySlot()],
  open_waits: options.open_waits ?? [], work_orders: options.work_orders ?? [],
});

/** A brief artifact from `brief_writer`, driving a fan-out unit named `unit_id` with the given dependencies. */
export const availableBrief = (unit_id: string, depends_on: readonly string[], artifact_id?: string, body?: JsonValue): AvailableArtifact => ({
  artifact_id: (artifact_id ?? stableUuid(`brief:${unit_id}`)) as ArtifactId, artifact_type: "dev.brief", output_name: PRODUCER_OUTPUT_NAME,
  unit_id: unit_id as UnitId, body: body ?? ({ depends_on } as JsonValue), producer_stage_key: PRODUCER_STAGE_KEY,
});

/**
 * The `input_fingerprint` `derive` will compute for a unit driven solely by
 * `brief` — matches production exactly (`fingerprintOf(envelopes(unitInputs))`
 * where `unitInputs.brief` is filtered down to the one matching artifact).
 * Set a stored `unit()`'s `input_fingerprint` to this to prove "no revision".
 */
export const fingerprintForBrief = (brief: AvailableArtifact): InputFingerprint => fingerprintOf([brief]);

let workOrderSeq = 0;
export const workOrder = (options: { readonly state: WorkOrder["state"]; readonly created_at?: string; readonly run_unit_id?: RunUnitId; readonly id?: string }): WorkOrder => {
  workOrderSeq += 1;
  const id = (options.id ?? stableUuid(`work-order:${workOrderSeq}`)) as WorkOrderId;
  const created_at = options.created_at ?? NOW;
  return {
    id, run_unit_id: options.run_unit_id ?? (stableUuid("placeholder-run-unit") as RunUnitId), reason: "initial",
    input_snapshot: [], input_fingerprint: "inputs" as InputFingerprint, state: options.state, workflow_id: `v2-work:${id}`,
    request_idempotency_key: "initial", created_at,
    completed_at: options.state === "completed" || options.state === "abandoned" ? created_at : null,
  };
};

const baseSlot = (state: RunOutputSlot["state"], options?: { readonly output_name?: string; readonly run_unit_id?: RunUnitId }): RunOutputSlot => ({
  run_unit_id: options?.run_unit_id ?? (stableUuid("placeholder-run-unit") as RunUnitId),
  identity: { kind: "scalar", output_name: options?.output_name ?? "result" }, output_name: options?.output_name ?? "result",
  artifact_type: "dev.build_result", required: true, release: { kind: "immediate" }, state,
  updated_by_work_order_id: null, version: 1 as OutputSlotVersion,
});

export const releasedSlot = (options?: { readonly output_name?: string; readonly run_unit_id?: RunUnitId; readonly artifact_id?: string }): RunOutputSlot =>
  baseSlot({ kind: "released", artifact_revision_id: (options?.artifact_id ?? stableUuid("released-slot")) as ArtifactId, released_at: NOW }, options);

export const emptySlot = (options?: { readonly output_name?: string; readonly run_unit_id?: RunUnitId }): RunOutputSlot => baseSlot({ kind: "empty" }, options);

let waitSeq = 0;
export const openWait = (options?: { readonly unit_id?: string; readonly stage_instance_id?: StageInstanceId }): Wait => {
  waitSeq += 1;
  return {
    id: stableUuid(`wait:${waitSeq}`) as WaitId, stage_instance_id: options?.stage_instance_id ?? (stableUuid("placeholder-stage") as StageInstanceId),
    unit_id: (options?.unit_id ?? "unit") as UnitId, artifact_revision_id: stableUuid("wait-artifact") as ArtifactId,
    closes_on: { kind: "gate", gate_step: "artifact_approval", actions: ["approve"] }, status: { kind: "open" },
    run_unit_id: null, output_name: null, execution_workflow_id: "v2-work:placeholder", command_workflow_id: "v2-wait:placeholder", opened_at: NOW,
  };
};

export const snapshot = (options?: {
  readonly run?: WorkflowRun; readonly definition?: CompiledWorkflowDefinition; readonly stages?: readonly StageSnapshot[]; readonly available_artifacts?: readonly AvailableArtifact[];
}): RunSnapshot => ({
  run: options?.run ?? run(), definition: options?.definition ?? emptyDefinition(),
  stages: options?.stages ?? [], available_artifacts: options?.available_artifacts ?? [],
});
