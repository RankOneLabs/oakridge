import { createHash, randomUUID } from "node:crypto";

import type { ArtifactRevision } from "../domain/artifacts";
import type { OutputReleaseContract } from "../domain/compiled-workflow";
import type { ArtifactEnvelope, ExecutionRequest, ExternalExecutionReference } from "../domain/execution";
import { err, ok, type ArtifactId, type InputFingerprint, type JsonValue, type OutputCollectionKey, type OutputSlotVersion, type Result, type RunRecordVersion, type RunTransitionId, type RunUnitId, type StageInstanceId, type UnitId, type WaitId, type WorkflowDefinitionId, type WorkflowRunId, type WorkOrderId } from "../domain/primitives";
import { selectRunDecision, selectStageDecision, selectUnitDecision } from "../domain/run-decisions";
import type { CancelRunRecord, CancelRunRecordResult, CloseRunOutputWait, CloseRunOutputWaitResult, ExecutorAttachment, ExecutorHealthObservation, FailRunMaterialization, InitializeStraightThroughRun, PersistMaterializedStage, PublishWorkOrderArtifact, PublishWorkOrderArtifactResult, RetryRunUnit, RetryRunUnitResult, ReviseRunUnitInput, ReviseRunUnitInputResult, RunDecision, RunMaterializationRecord, RunOutputSlot, RunOutputWaitDisposition, RunStage, RunTransitionOperation, RunUnit, UnitDecision, WorkflowRun, WorkOrder, WorkOrderExecution } from "../domain/run-record";
import type { WaitClosesOn, WaitOutcome } from "../domain/wait";
import type { StageOutcome } from "../domain/workflow";
import type { AdmitStageUnitRequest, AdmitStageUnitResult } from "../domain/runs";
import type { DeleteRunResult } from "../domain/runs";
import { decodeWait, waitColumns, type WaitRow } from "./postgres-wait";
import type { RunRecordRepository, RunRecordRepositoryError } from "./repositories";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

interface RunRow { readonly id: string; readonly workflow_definition_id: string; readonly workflow_definition_version: number; readonly context: JsonValue; readonly state: WorkflowRun["state"]; readonly outcome: StageOutcome | null; readonly record_version: string; readonly created_at: string; readonly ended_at: string | null }
interface StageRow { readonly id: string; readonly run_id: string; readonly stage_key: string; readonly stage_contract: JsonValue; readonly state: RunStage["state"]; readonly outcome: StageOutcome | null; readonly materialization_closed: boolean; readonly started_at: string; readonly ended_at: string | null }
interface UnitRow { readonly id: string; readonly run_id: string; readonly stage_instance_id: string; readonly unit_id: string; readonly parameters: JsonValue; readonly input_snapshot: readonly ArtifactEnvelope[]; readonly input_fingerprint: string; readonly state: RunUnit["state"]; readonly admitted: boolean; readonly admitted_at: string | null; readonly outcome: StageOutcome | null; readonly created_at: string; readonly ended_at: string | null }
interface SlotRow { readonly run_unit_id: string; readonly output_name: string; readonly collection_key: string | null; readonly artifact_type: string; readonly required: boolean; readonly release_policy: OutputReleaseContract; readonly state: "empty" | "pending" | "released" | "invalidated"; readonly artifact_revision_id: string | null; readonly release_wait_id: string | null; readonly invalidation_reason: RunOutputSlot["state"] extends { kind: "invalidated"; reason: infer Reason } ? Reason : never; readonly state_changed_at: string | null; readonly updated_by_work_order_id: string | null; readonly version: string }
interface WorkOrderRow { readonly id: string; readonly run_unit_id: string; readonly reason: WorkOrder["reason"]; readonly input_snapshot: readonly ArtifactEnvelope[]; readonly input_fingerprint: string; readonly state: WorkOrder["state"]; readonly workflow_id: string; readonly request_idempotency_key: string; readonly execution_request?: ExecutionRequest | null; readonly created_at: string; readonly completed_at: string | null }
interface ArtifactRow { readonly id: string; readonly run_id: string; readonly stage_instance_id: string; readonly execution_id: string; readonly unit_id: string; readonly output_name: string; readonly collection_key: string | null; readonly artifact_type: string; readonly label: string | null; readonly body: JsonValue; readonly version: number; readonly parent_artifact_id: string | null; readonly released_at: string; readonly created_at: string }
interface ExecutorAttachmentRow { readonly work_order_id: string; readonly executor_type: string; readonly external_reference: ExternalExecutionReference | null; readonly health: ExecutorHealthObservation | null; readonly cleanup_state: ExecutorAttachment["cleanup_state"]; readonly updated_at: string }
class GateCoordinationConflict extends Error { constructor(readonly result: CloseRunOutputWaitResult) { super("gate coordination conflict"); } }
interface StoredOutputContracts { readonly [output_name: string]: { readonly artifact_type: string; readonly required: boolean; readonly release: OutputReleaseContract } }

const decodeRun = (row: RunRow): WorkflowRun => ({ ...row, id: row.id as WorkflowRunId, workflow_definition_id: row.workflow_definition_id as WorkflowDefinitionId, record_version: Number(row.record_version) as RunRecordVersion });
const decodeStage = (row: StageRow): RunStage => ({ id: row.id as StageInstanceId, run_id: row.run_id as WorkflowRunId, stage_key: row.stage_key, contract: row.stage_contract, state: row.state, outcome: row.outcome, materialization_closed: row.materialization_closed, created_at: row.started_at, ended_at: row.ended_at });
const decodeUnit = (row: UnitRow): RunUnit => ({ ...row, id: row.id as RunUnitId, run_id: row.run_id as WorkflowRunId, stage_instance_id: row.stage_instance_id as StageInstanceId, unit_id: row.unit_id as UnitId, input_fingerprint: row.input_fingerprint as InputFingerprint });
const decodeOrder = (row: WorkOrderRow): WorkOrder => ({ ...row, id: row.id as WorkOrderId, run_unit_id: row.run_unit_id as RunUnitId, input_fingerprint: row.input_fingerprint as InputFingerprint });
const decodeSlot = (row: SlotRow): RunOutputSlot => {
  const identity = row.collection_key === null
    ? { kind: "scalar" as const, output_name: row.output_name }
    : { kind: "collection_member" as const, output_name: row.output_name, collection_key: row.collection_key as OutputCollectionKey };
  const base = { run_unit_id: row.run_unit_id as RunUnitId, identity, output_name: row.output_name, artifact_type: row.artifact_type, required: row.required, release: row.release_policy, updated_by_work_order_id: row.updated_by_work_order_id as WorkOrderId | null, version: Number(row.version) as OutputSlotVersion };
  if (row.state === "empty") return { ...base, state: { kind: "empty" } };
  if (row.state === "pending" && row.artifact_revision_id && row.release_wait_id && row.state_changed_at) return { ...base, state: { kind: "pending", artifact_revision_id: row.artifact_revision_id as ArtifactId, release_wait_id: row.release_wait_id as RunOutputSlot["state"] extends { kind: "pending"; release_wait_id: infer Id } ? Id : never, pending_at: row.state_changed_at } };
  if (row.state === "released" && row.artifact_revision_id && row.state_changed_at) return { ...base, state: { kind: "released", artifact_revision_id: row.artifact_revision_id as ArtifactId, released_at: row.state_changed_at } };
  if (row.state === "invalidated" && row.invalidation_reason && row.state_changed_at) return { ...base, state: { kind: "invalidated", previous_artifact_revision_id: row.artifact_revision_id as ArtifactId | null, reason: row.invalidation_reason, invalidated_at: row.state_changed_at } };
  throw new Error(`output slot '${row.run_unit_id}:${row.output_name}' has an invalid '${row.state}' shape`);
};

const artifactRow = (row: ArtifactRow): ArtifactRevision => ({ id: row.id as ArtifactId, chain_id: row.id as ArtifactId, run_id: row.run_id as WorkflowRunId, stage_instance_id: row.stage_instance_id as StageInstanceId, execution_id: row.execution_id as ExecutionRequest["execution_id"], unit_id: row.unit_id as UnitId, output_name: row.output_name, collection_key: row.collection_key as OutputCollectionKey | null, artifact_type: row.artifact_type, label: row.label, body: row.body, version: row.version, parent_artifact_id: row.parent_artifact_id as ArtifactId | null, lifecycle: { kind: "released", released_at: row.released_at }, created_at: row.created_at });

/**
 * Appends one typed transition row inside the caller's own transaction. This
 * is the only place `oakridge.run_transition` is written, so every commit
 * that can move `record_version` leaves a row naming exactly the boundary it
 * crossed — never inferred later from executor state or DBOS history.
 */
interface TransitionInput {
  readonly run_id: WorkflowRunId;
  readonly run_unit_id: RunUnitId | null;
  readonly work_order_id: WorkOrderId | null;
  readonly wait_id: WaitId | null;
  readonly output_name: string | null;
  readonly collection_key?: OutputCollectionKey | null;
  readonly operation: RunTransitionOperation;
  readonly actor: string;
  readonly prior_record_version: RunRecordVersion;
  readonly resulting_record_version: RunRecordVersion;
  readonly detail: JsonValue;
  readonly created_at: string;
}

const insertTransition = async (transaction: SqlExecutor, input: TransitionInput): Promise<void> => {
  await transaction.query(
    `INSERT INTO oakridge.run_transition
       (id, run_id, run_unit_id, work_order_id, wait_id, output_name, collection_key, operation, actor, prior_record_version, resulting_record_version, detail, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::timestamptz)`,
    [randomUUID() as RunTransitionId, input.run_id, input.run_unit_id, input.work_order_id, input.wait_id, input.output_name,
      input.collection_key ?? null, input.operation, input.actor, input.prior_record_version, input.resulting_record_version, input.detail, input.created_at],
  );
};

/**
 * Nothing ever sends a DBOS command to a v2 wait, but the column is
 * `NOT NULL` and `(command_workflow_id, kind)` must stay unique across every
 * wait row — including a second wait later opened on the same slot after the
 * first closed (invalidate, then a fresh publish). Keyed to the wait's own
 * generated id, not the slot, so it is unique per wait instance rather than
 * colliding on a slot a second wait can legitimately reuse.
 */
const v2WaitCommandAddress = (waitId: WaitId): string => `v2-wait:${waitId}`;

const stageMaterializationFingerprint = (input: PersistMaterializedStage): string => createHash("sha256").update(JSON.stringify({
  stage_instance_id: input.stage_instance_id, stage_key: input.stage_key, stage_type: input.stage_type,
  stage_contract: input.stage_contract, policy: input.policy,
})).digest("hex");

const unitMaterializationFingerprint = (unit: PersistMaterializedStage["units"][number]): string =>
  createHash("sha256").update(JSON.stringify(unit)).digest("hex");

interface StoredGraphUnit { readonly unit_id: string; readonly depends_on: readonly string[] }
const assertClosedGraph = (stageKey: string, units: readonly StoredGraphUnit[]): void => {
  const ids = new Set(units.map((unit) => unit.unit_id));
  const byId = new Map(units.map((unit) => [unit.unit_id, unit]));
  for (const unit of units) for (const dependency of unit.depends_on) if (!ids.has(dependency)) throw new Error(`materialized unit '${unit.unit_id}' has unknown dependency '${dependency}'`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (unitId: string): void => {
    if (visiting.has(unitId)) throw new Error(`materialized stage '${stageKey}' contains a dependency cycle`);
    if (visited.has(unitId)) return;
    visiting.add(unitId);
    for (const dependency of byId.get(unitId)?.depends_on ?? []) visit(String(dependency));
    visiting.delete(unitId);
    visited.add(unitId);
  };
  for (const unitId of ids) visit(unitId);
};

const assertIncomingUnits = (input: PersistMaterializedStage): void => {
  const ids = input.units.map((unit) => String(unit.unit_id));
  if (new Set(ids).size !== ids.length) throw new Error(`materialized stage '${input.stage_key}' repeats a unit id`);
  for (const unit of input.units) {
    const dependencies = unit.depends_on.map(String);
    if (dependencies.includes(String(unit.unit_id))) throw new Error(`materialized unit '${unit.unit_id}' depends on itself`);
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`materialized unit '${unit.unit_id}' repeats a dependency`);
    const request = unit.initial_work_order.request;
    if (request.execution_id !== (unit.initial_work_order.id as unknown as ExecutionRequest["execution_id"]) || request.stage_instance_id !== input.stage_instance_id || request.unit_id !== unit.unit_id) {
      throw new Error(`materialized unit '${unit.unit_id}' has a mismatched execution request identity`);
    }
    if (JSON.stringify(request.inputs) !== JSON.stringify(unit.input_snapshot)) throw new Error(`materialized unit '${unit.unit_id}' has a mismatched execution input snapshot`);
  }
};

export class PostgresRunRecordRepository implements RunRecordRepository {
  constructor(private readonly sql: TransactionalSqlExecutor) {}

  async initialize_straight_through(input: InitializeStraightThroughRun): Promise<void> {
    await this.sql.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`v2-run:${input.run_id}`]);
      const runs = await transaction.query<{ readonly id: string }>("SELECT id::text FROM oakridge.workflow_run WHERE id = $1 FOR UPDATE", [input.run_id]);
      if (!runs[0]) throw new Error(`workflow run '${input.run_id}' was not found`);
      const stageContract = { executor_type: input.executor_type, resolved_config: input.resolved_config, outputs: input.outputs };
      const storedStages = await transaction.query<{ readonly immutable_matches: boolean }>(
        `SELECT id = $3::uuid AND stage_contract = $4::jsonb AS immutable_matches FROM oakridge.stage_instance
         WHERE run_id = $1 AND stage_key = $2 AND attempt_root_workflow_id IS NULL FOR UPDATE`,
        [input.run_id, input.stage_key, input.stage_instance_id, stageContract],
      );
      const storedStage = storedStages[0];
      if (storedStage && !storedStage.immutable_matches) {
        throw new Error(`straight-through run '${input.run_id}' conflicts with its stored initialization`);
      }
      const outputContracts: StoredOutputContracts = Object.fromEntries(input.outputs.map((output) => [output.name, { artifact_type: output.artifact_type, required: output.required, release: output.release }]));
      const existing = await transaction.query<{ readonly immutable_matches: boolean }>(`SELECT
          stage.id = $3::uuid
          AND stage.stage_contract = $4::jsonb
          AND unit.id = $5::uuid
          AND unit.unit_id = $6
          AND unit.parameters = $7::jsonb
          AND unit.input_snapshot = $8::jsonb
          AND unit.input_fingerprint = $9
          AND work.id = $10::uuid
          AND work.workflow_id = $11
          AND work.capability_hash = $12
          AND (SELECT coalesce(jsonb_object_agg(slot.output_name,
                jsonb_build_object('artifact_type', slot.artifact_type, 'required', slot.required, 'release', slot.release_policy)), '{}'::jsonb)
               FROM oakridge.run_output_slot slot WHERE slot.run_unit_id = unit.id) = $13::jsonb AS immutable_matches
        FROM oakridge.stage_instance stage
        JOIN oakridge.run_unit unit ON unit.stage_instance_id = stage.id
        JOIN oakridge.work_order work ON work.run_unit_id = unit.id AND work.request_idempotency_key = 'initial'
        WHERE stage.run_id = $1 AND stage.stage_key = $2 AND stage.attempt_root_workflow_id IS NULL`, [input.run_id, input.stage_key, input.stage_instance_id,
        stageContract, input.run_unit_id, input.unit_id,
        input.parameters, JSON.stringify(input.input_snapshot), input.input_fingerprint, input.work_order_id, input.work_order_workflow_id,
        input.work_order_capability_hash, outputContracts]);
      if (existing[0]) {
        if (!existing[0].immutable_matches) throw new Error(`straight-through run '${input.run_id}' conflicts with its stored initialization`);
        return;
      }
      await transaction.query(`INSERT INTO oakridge.stage_instance
        (id, run_id, stage_key, stage_type, stage_contract, attempt_root_workflow_id, coordinator_workflow_id, started_at, state, materialization_closed)
        VALUES ($1,$2,$3,$4,$5::jsonb,NULL,$6,$7::timestamptz,'active',true)
        ON CONFLICT (run_id, stage_key) WHERE attempt_root_workflow_id IS NULL DO NOTHING`, [input.stage_instance_id, input.run_id, input.stage_key, input.executor_type,
        stageContract, `v2-stage:${input.stage_instance_id}`, input.created_at]);
      await transaction.query(`INSERT INTO oakridge.run_unit
        (id, run_id, stage_instance_id, unit_id, parameters, input_snapshot, input_fingerprint, state, created_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,'ready',$8::timestamptz)
        ON CONFLICT (stage_instance_id, unit_id) DO NOTHING`, [input.run_unit_id, input.run_id, input.stage_instance_id, input.unit_id, input.parameters, JSON.stringify(input.input_snapshot), input.input_fingerprint, input.created_at]);
      for (const output of input.outputs) await transaction.query(`INSERT INTO oakridge.run_output_slot
        (run_unit_id, output_name, artifact_type, required, release_policy, state)
        VALUES ($1,$2,$3,$4,$5::jsonb,'empty') ON CONFLICT (run_unit_id, output_name) WHERE collection_key IS NULL DO NOTHING`, [input.run_unit_id, output.name, output.artifact_type, output.required, output.release]);
      await transaction.query(`INSERT INTO oakridge.work_order
        (id, run_unit_id, reason, input_snapshot, input_fingerprint, state, workflow_id, request_idempotency_key, capability_hash, created_at)
        VALUES ($1,$2,'initial',$3::jsonb,$4,'available',$5,'initial',$6,$7::timestamptz)
        ON CONFLICT (run_unit_id, request_idempotency_key) DO NOTHING`, [input.work_order_id, input.run_unit_id, JSON.stringify(input.input_snapshot), input.input_fingerprint, input.work_order_workflow_id, input.work_order_capability_hash, input.created_at]);
      await transaction.query("UPDATE oakridge.workflow_run SET record_version = record_version + 1 WHERE id = $1", [input.run_id]);
    });
  }

  async load_materialization_record(run_id: WorkflowRunId): Promise<RunMaterializationRecord | null> {
    const runRows = await this.sql.query<RunRow>(`SELECT run.id::text,run.workflow_definition_id::text,definition.version AS workflow_definition_version,
      run.context,run.state,run.outcome,run.record_version::text,run.created_at::text,run.ended_at::text
      FROM oakridge.workflow_run run JOIN oakridge.workflow_definition definition ON definition.id=run.workflow_definition_id WHERE run.id=$1`, [run_id]);
    const row = runRows[0];
    if (!row) return null;
    const stageRows = await this.sql.query<StageRow>(`SELECT id::text,run_id::text,stage_key,stage_contract,state,outcome,materialization_closed,started_at::text,ended_at::text
      FROM oakridge.stage_instance WHERE run_id=$1 AND attempt_root_workflow_id IS NULL ORDER BY stage_key`, [run_id]);
    const units = await this.sql.query<{ readonly id: string; readonly stage_instance_id: string; readonly unit_id: string; readonly input_fingerprint: string; readonly state: RunUnit["state"] }>(
      `SELECT id::text,stage_instance_id::text,unit_id,input_fingerprint,state FROM oakridge.run_unit WHERE run_id=$1 ORDER BY stage_instance_id,unit_id`, [run_id]);
    const byStage = new Map<string, typeof units>();
    for (const unit of units) byStage.set(unit.stage_instance_id, [...(byStage.get(unit.stage_instance_id) ?? []), unit]);
    const artifacts = await this.sql.query<{ readonly id: string; readonly chain_id: string; readonly stage_key: string; readonly execution_id: string; readonly unit_id: string; readonly output_name: string; readonly artifact_type: string; readonly body: JsonValue }>(
      `SELECT artifact.id::text,artifact.chain_id::text,stage.stage_key,artifact.execution_id,artifact.unit_id,artifact.output_name,artifact.artifact_type,artifact.body
       FROM oakridge.run_output_slot slot
       JOIN oakridge.run_unit unit ON unit.id=slot.run_unit_id
       JOIN oakridge.stage_instance stage ON stage.id=unit.stage_instance_id
       JOIN oakridge.artifact artifact ON artifact.id=slot.artifact_revision_id
       WHERE unit.run_id=$1 AND (slot.state='released' OR (slot.state='pending' AND slot.release_policy->>'kind'='handoff'))
       ORDER BY stage.stage_key,artifact.output_name,artifact.unit_id,artifact.created_at`, [run_id]);
    return {
      run: decodeRun(row),
      stages: stageRows.map((stage) => ({ id: stage.id as StageInstanceId, stage_key: stage.stage_key, state: stage.state,
        materialization_closed: stage.materialization_closed,
        units: (byStage.get(stage.id) ?? []).map((unit) => ({ id: unit.id as RunUnitId, unit_id: unit.unit_id as UnitId, input_fingerprint: unit.input_fingerprint as InputFingerprint, state: unit.state })) })),
      available_artifacts: artifacts.map((artifact) => ({ artifact_id: artifact.id as ArtifactId, chain_id: artifact.chain_id as ArtifactId,
        producer_stage_key: artifact.stage_key, producer_execution_id: artifact.execution_id as ExecutionRequest["execution_id"],
        unit_id: artifact.unit_id as UnitId, output_name: artifact.output_name, artifact_type: artifact.artifact_type, body: artifact.body })),
    };
  }

  async load_work_order_capability_seed(): Promise<string> {
    const rows = await this.sql.query<{ readonly value: string }>("SELECT value FROM oakridge.runtime_secret WHERE name='work_order_capability'", []);
    const seed = rows[0]?.value;
    if (!seed) throw new Error("work-order capability seed is unavailable");
    return seed;
  }

  async fail_materialization(input: FailRunMaterialization): Promise<void> {
    await this.sql.transaction(async (transaction) => {
      const rows = await transaction.query<{ readonly state: WorkflowRun["state"]; readonly record_version: string }>(
        "SELECT state,record_version::text FROM oakridge.workflow_run WHERE id=$1 FOR UPDATE", [input.run_id]);
      const run = rows[0];
      if (!run || run.state !== "active") return;
      const outcome = { kind: "failed" as const, code: "materialization_failed", detail: input.detail };
      if (input.stage_key) await transaction.query(`UPDATE oakridge.stage_instance SET state='failed',outcome=$3::jsonb,ended_at=$4::timestamptz
        WHERE run_id=$1 AND stage_key=$2 AND attempt_root_workflow_id IS NULL AND state='active'`, [input.run_id, input.stage_key, outcome, input.failed_at]);
      const versions = await transaction.query<{ readonly record_version: string }>(`UPDATE oakridge.workflow_run
        SET state='failed',outcome=$2::jsonb,ended_at=$3::timestamptz,record_version=record_version+1 WHERE id=$1 RETURNING record_version::text`,
      [input.run_id, outcome, input.failed_at]);
      const resulting = Number(versions[0]?.record_version ?? Number(run.record_version) + 1) as RunRecordVersion;
      await insertTransition(transaction, { run_id: input.run_id, run_unit_id: null, work_order_id: null, wait_id: null, output_name: null,
        operation: "materialization_failed", actor: "compiler", prior_record_version: Number(run.record_version) as RunRecordVersion,
        resulting_record_version: resulting, detail: { stage_key: input.stage_key, error: input.detail }, created_at: input.failed_at });
    });
  }

  async cancel_run(input: CancelRunRecord): Promise<CancelRunRecordResult> {
    return this.sql.transaction(async (transaction) => {
      const rows = await transaction.query<{ readonly state: WorkflowRun["state"]; readonly record_version: string }>(
        "SELECT state,record_version::text FROM oakridge.workflow_run WHERE id=$1 FOR UPDATE", [input.run_id]);
      const run = rows[0];
      if (!run) return { kind: "run_not_found", detail: `workflow run '${input.run_id}' was not found` };
      if (run.state !== "active") return { kind: "already_terminal", run_id: input.run_id, state: run.state };
      const fenceRows = await transaction.query<{ readonly work_order_id: string; readonly executor_type: string; readonly external_reference: ExternalExecutionReference }>(
        `SELECT work.id::text AS work_order_id,attachment.executor_type,attachment.external_reference
         FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id=work.run_unit_id
         JOIN oakridge.executor_attachment attachment ON attachment.work_order_id=work.id
         WHERE unit.run_id=$1 AND work.state IN ('available','started') AND attachment.external_reference IS NOT NULL
         ORDER BY work.id FOR UPDATE OF work,unit,attachment`, [input.run_id]);
      const outcome = { kind: "cancelled" as const, reason: input.reason };
      await transaction.query("UPDATE oakridge.wait SET status='closed',outcome=$2::jsonb,closed_at=$3::timestamptz WHERE run_unit_id IN (SELECT id FROM oakridge.run_unit WHERE run_id=$1) AND status='open'",
        [input.run_id, outcome, input.cancelled_at]);
      await transaction.query(`UPDATE oakridge.run_output_slot SET state='invalidated',release_wait_id=NULL,
        invalidation_reason=jsonb_build_object('kind','operator','detail','run cancelled'),state_changed_at=$2::timestamptz,version=version+1
        WHERE run_unit_id IN (SELECT id FROM oakridge.run_unit WHERE run_id=$1) AND state='pending'`, [input.run_id, input.cancelled_at]);
      await transaction.query("UPDATE oakridge.work_order SET state='abandoned',completed_at=$2::timestamptz WHERE run_unit_id IN (SELECT id FROM oakridge.run_unit WHERE run_id=$1) AND state IN ('available','started')", [input.run_id, input.cancelled_at]);
      await transaction.query("UPDATE oakridge.run_unit SET state='cancelled',outcome=$2::jsonb,ended_at=$3::timestamptz WHERE run_id=$1 AND state NOT IN ('satisfied','failed','cancelled')", [input.run_id, outcome, input.cancelled_at]);
      await transaction.query("UPDATE oakridge.stage_instance SET state='cancelled',outcome=$2::jsonb,ended_at=$3::timestamptz WHERE run_id=$1 AND attempt_root_workflow_id IS NULL AND state='active'", [input.run_id, outcome, input.cancelled_at]);
      const versions = await transaction.query<{ readonly record_version: string }>(`UPDATE oakridge.workflow_run SET state='cancelled',outcome=$2::jsonb,
        ended_at=$3::timestamptz,record_version=record_version+1 WHERE id=$1 RETURNING record_version::text`, [input.run_id, outcome, input.cancelled_at]);
      const resulting = Number(versions[0]?.record_version ?? Number(run.record_version) + 1) as RunRecordVersion;
      await insertTransition(transaction, { run_id: input.run_id, run_unit_id: null, work_order_id: null, wait_id: null, output_name: null,
        operation: "run_cancelled", actor: input.actor, prior_record_version: Number(run.record_version) as RunRecordVersion,
        resulting_record_version: resulting, detail: { reason: input.reason }, created_at: input.cancelled_at });
      return { kind: "cancelled", run_id: input.run_id, record_version: resulting,
        work_orders_to_fence: fenceRows.map((row) => ({ work_order_id: row.work_order_id as WorkOrderId,
          executor_type: row.executor_type, external_reference: row.external_reference })) };
    });
  }

  async delete_run(run_id: WorkflowRunId): Promise<DeleteRunResult> {
    return this.sql.transaction(async (transaction) => {
      const rows = await transaction.query<{ readonly state: WorkflowRun["state"] }>("SELECT state FROM oakridge.workflow_run WHERE id=$1 FOR UPDATE", [run_id]);
      const run = rows[0];
      if (!run) return { kind: "already_deleted", run_id };
      if (run.state === "active") return { kind: "active_conflict", run_id, detail: "run is active; cancel it before deletion" };
      await transaction.query(`DELETE FROM oakridge.command_outbox command WHERE command.payload->>'run_id'=$1::text OR command.target_workflow_id IN (
        SELECT work.workflow_id FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id=work.run_unit_id WHERE unit.run_id=$1::uuid)`, [run_id]);
      await transaction.query("DELETE FROM oakridge.workflow_run WHERE id=$1", [run_id]);
      return { kind: "deleted", run_id };
    });
  }

  async persist_materialized_stage(input: PersistMaterializedStage): Promise<void> {
    assertIncomingUnits(input);
    await this.sql.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`v2-run:${input.run_id}`]);
      const runRows = await transaction.query<{ readonly record_version: string }>("SELECT record_version::text FROM oakridge.workflow_run WHERE id = $1 FOR UPDATE", [input.run_id]);
      const run = runRows[0];
      if (!run) throw new Error(`workflow run '${input.run_id}' was not found`);
      const fingerprint = stageMaterializationFingerprint(input);
      const stored = await transaction.query<{ readonly materialization_fingerprint: string; readonly materialization_closed: boolean }>(`SELECT policy.materialization_fingerprint,stage.materialization_closed
        FROM oakridge.stage_instance stage JOIN oakridge.run_stage_scheduling_policy policy ON policy.stage_instance_id = stage.id
        WHERE stage.run_id = $1 AND stage.stage_key = $2 AND stage.attempt_root_workflow_id IS NULL FOR UPDATE OF stage, policy`, [input.run_id, input.stage_key]);
      if (stored[0]) {
        if (stored[0].materialization_fingerprint !== fingerprint) throw new Error(`materialized stage '${input.stage_key}' conflicts with its stored graph`);
      } else {
        await transaction.query(`INSERT INTO oakridge.stage_instance
        (id, run_id, stage_key, stage_type, stage_contract, attempt_root_workflow_id, coordinator_workflow_id, started_at, state, materialization_closed)
        VALUES ($1,$2,$3,$4,$5::jsonb,NULL,$6,$7::timestamptz,'active',false)
        ON CONFLICT (run_id, stage_key) WHERE attempt_root_workflow_id IS NULL DO NOTHING`,
        [input.stage_instance_id, input.run_id, input.stage_key, input.stage_type, input.stage_contract, `v2-stage:${input.stage_instance_id}`, input.materialized_at]);
      }
      const stageRows = await transaction.query<{ readonly id: string; readonly immutable_matches: boolean }>(`SELECT id::text,
        id = $3::uuid AND stage_type = $4 AND stage_contract = $5::jsonb AS immutable_matches
        FROM oakridge.stage_instance WHERE run_id = $1 AND stage_key = $2 AND attempt_root_workflow_id IS NULL FOR UPDATE`,
      [input.run_id, input.stage_key, input.stage_instance_id, input.stage_type, input.stage_contract]);
      if (!stageRows[0]?.immutable_matches) throw new Error(`materialized stage '${input.stage_key}' conflicts with its stored identity`);
      if (!stored[0]) await transaction.query(`INSERT INTO oakridge.run_stage_scheduling_policy
        (stage_instance_id,max_parallel,manual_admission,materialization_fingerprint) VALUES ($1,$2,$3,$4)`,
      [input.stage_instance_id, input.policy.max_parallel, input.policy.manual_admission, fingerprint]);
      let changed = !stored[0];
      let didClose = false;
      if (stored[0]?.materialization_closed && input.units.length > 0) {
        const existingIds = await transaction.query<{ readonly unit_id: string }>("SELECT unit_id FROM oakridge.run_unit WHERE stage_instance_id=$1 AND unit_id=ANY($2::text[])", [input.stage_instance_id, input.units.map((unit) => unit.unit_id)]);
        if (existingIds.length !== input.units.length) throw new Error(`materialized stage '${input.stage_key}' is already closed`);
      }
      for (const unit of input.units) {
        const unitFingerprint = unitMaterializationFingerprint(unit);
        const existingUnits = await transaction.query<{ readonly materialization_fingerprint: string | null }>("SELECT materialization_fingerprint FROM oakridge.run_unit WHERE stage_instance_id=$1 AND unit_id=$2 FOR UPDATE", [input.stage_instance_id, unit.unit_id]);
        if (existingUnits[0]) {
          if (existingUnits[0].materialization_fingerprint !== unitFingerprint) throw new Error(`materialized unit '${unit.unit_id}' conflicts with its stored graph`);
          continue;
        }
        changed = true;
        const admitted = !input.policy.manual_admission;
        await transaction.query(`INSERT INTO oakridge.run_unit
          (id,run_id,stage_instance_id,unit_id,parameters,input_snapshot,input_fingerprint,state,admitted,admitted_at,materialization_fingerprint,created_at)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,'ready',$8,$9::timestamptz,$10,$11::timestamptz)`,
        [unit.id, input.run_id, input.stage_instance_id, unit.unit_id, unit.parameters, JSON.stringify(unit.input_snapshot), unit.input_fingerprint,
          admitted, admitted ? input.materialized_at : null, unitFingerprint, input.materialized_at]);
        for (const output of unit.outputs) await transaction.query(`INSERT INTO oakridge.run_output_slot
          (run_unit_id,output_name,collection_key,artifact_type,required,release_policy,state)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,'empty')`, [unit.id, output.identity.output_name,
          output.identity.kind === "collection_member" ? output.identity.collection_key : null, output.artifact_type, output.required, output.release]);
        await transaction.query(`INSERT INTO oakridge.work_order
          (id,run_unit_id,reason,input_snapshot,input_fingerprint,state,workflow_id,request_idempotency_key,capability_hash,execution_request,created_at)
          VALUES ($1,$2,'initial',$3::jsonb,$4,'available',$5,'initial',$6,$7::jsonb,$8::timestamptz)`,
        [unit.initial_work_order.id, unit.id, JSON.stringify(unit.input_snapshot), unit.input_fingerprint, unit.initial_work_order.workflow_id, unit.initial_work_order.capability_hash, unit.initial_work_order.request, input.materialized_at]);
      }
      for (const unit of input.units) for (const dependency of unit.depends_on) await transaction.query(`INSERT INTO oakridge.run_unit_dependency
        (stage_instance_id,unit_id,depends_on_unit_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [input.stage_instance_id, unit.unit_id, dependency]);
      if (input.close_materialization && !stored[0]?.materialization_closed) {
        const graphRows = await transaction.query<{ readonly unit_id: string; readonly depends_on_unit_id: string | null }>(`SELECT unit.unit_id,edge.depends_on_unit_id FROM oakridge.run_unit unit
          LEFT JOIN oakridge.run_unit_dependency edge ON edge.stage_instance_id=unit.stage_instance_id AND edge.unit_id=unit.unit_id
          WHERE unit.stage_instance_id=$1 ORDER BY unit.unit_id,edge.depends_on_unit_id`, [input.stage_instance_id]);
        const graph = new Map<string, string[]>();
        for (const graphRow of graphRows) graph.set(graphRow.unit_id, graphRow.depends_on_unit_id === null ? (graph.get(graphRow.unit_id) ?? []) : [...(graph.get(graphRow.unit_id) ?? []), graphRow.depends_on_unit_id]);
        assertClosedGraph(input.stage_key, [...graph].map(([unit_id, depends_on]) => ({ unit_id, depends_on })));
        await transaction.query("UPDATE oakridge.stage_instance SET materialization_closed=true WHERE id=$1", [input.stage_instance_id]);
        changed = true;
        didClose = true;
      }
      if (!changed) return;
      const prior = Number(run.record_version) as RunRecordVersion;
      const resulting = (Number(run.record_version) + 1) as RunRecordVersion;
      await transaction.query("UPDATE oakridge.workflow_run SET record_version = $2 WHERE id = $1", [input.run_id, resulting]);
      await insertTransition(transaction, { run_id: input.run_id, run_unit_id: null, work_order_id: null, wait_id: null, output_name: null,
        operation: "stage_materialized", actor: "compiler", prior_record_version: prior, resulting_record_version: resulting,
        detail: { stage_instance_id: input.stage_instance_id, unit_count: input.units.length, materialization_closed: input.close_materialization }, created_at: input.materialized_at });
      if (didClose) await insertTransition(transaction, { run_id: input.run_id, run_unit_id: null, work_order_id: null, wait_id: null, output_name: null,
        operation: "materialization_closed", actor: "compiler", prior_record_version: prior, resulting_record_version: resulting,
        detail: { stage_instance_id: input.stage_instance_id }, created_at: input.materialized_at });
    });
  }

  async revise_unit_input(input: ReviseRunUnitInput): Promise<ReviseRunUnitInputResult> {
    return this.sql.transaction(async (transaction) => {
      const rows = await transaction.query<{ readonly run_id: string; readonly stage_instance_id: string; readonly unit_id: string; readonly input_fingerprint: string; readonly record_version: string }>(`SELECT unit.run_id::text,unit.stage_instance_id::text,unit.unit_id, unit.input_fingerprint, run.record_version::text
        FROM oakridge.run_unit unit JOIN oakridge.workflow_run run ON run.id = unit.run_id WHERE unit.id = $1 FOR UPDATE OF unit, run`, [input.run_unit_id]);
      const row = rows[0];
      if (!row) return { kind: "unit_not_found", detail: `run unit '${input.run_unit_id}' was not found` };
      if (row.input_fingerprint === input.input_fingerprint) return { kind: "unchanged", run_id: row.run_id as WorkflowRunId, record_version: Number(row.record_version) as RunRecordVersion };
      const replacement = input.replacement_work_order;
      if (replacement.request.execution_id !== (replacement.id as unknown as ExecutionRequest["execution_id"]) || replacement.request.stage_instance_id !== row.stage_instance_id || replacement.request.unit_id !== row.unit_id || JSON.stringify(replacement.request.inputs) !== JSON.stringify(input.input_snapshot)) {
        throw new Error(`replacement work order for '${input.run_unit_id}' has a mismatched execution request`);
      }
      await transaction.query(`UPDATE oakridge.run_unit SET input_snapshot=$2::jsonb,input_fingerprint=$3,state='ready',outcome=NULL,ended_at=NULL WHERE id=$1`,
        [input.run_unit_id, JSON.stringify(input.input_snapshot), input.input_fingerprint]);
      await transaction.query(`UPDATE oakridge.work_order SET state='abandoned',completed_at=$2::timestamptz WHERE run_unit_id=$1 AND state IN ('available','started')`, [input.run_unit_id, input.revised_at]);
      await transaction.query(`UPDATE oakridge.wait SET status='closed',outcome='{"kind":"withdrawn"}'::jsonb,closed_at=$2::timestamptz WHERE run_unit_id=$1 AND status='open'`, [input.run_unit_id, input.revised_at]);
      await transaction.query(`UPDATE oakridge.run_output_slot SET state='invalidated',release_wait_id=NULL,
        invalidation_reason=$2::jsonb,state_changed_at=$3::timestamptz,updated_by_work_order_id=NULL,version=version+1 WHERE run_unit_id=$1`,
      [input.run_unit_id, { kind: "input_revision", input_fingerprint: input.input_fingerprint }, input.revised_at]);
      await transaction.query(`INSERT INTO oakridge.work_order
        (id,run_unit_id,reason,input_snapshot,input_fingerprint,state,workflow_id,request_idempotency_key,capability_hash,execution_request,created_at)
        VALUES ($1,$2,'input_revision',$3::jsonb,$4,'available',$5,$6,$7,$8::jsonb,$9::timestamptz)`,
      [replacement.id, input.run_unit_id, JSON.stringify(input.input_snapshot), input.input_fingerprint, replacement.workflow_id,
        `input_revision:${input.input_fingerprint}`, replacement.capability_hash, replacement.request, input.revised_at]);
      const prior = Number(row.record_version) as RunRecordVersion;
      const resulting = (Number(row.record_version) + 1) as RunRecordVersion;
      await transaction.query("UPDATE oakridge.workflow_run SET record_version=$2 WHERE id=$1", [row.run_id, resulting]);
      await insertTransition(transaction, { run_id: row.run_id as WorkflowRunId, run_unit_id: input.run_unit_id, work_order_id: null, wait_id: null, output_name: null,
        operation: "input_revised", actor: input.actor, prior_record_version: prior, resulting_record_version: resulting,
        detail: { input_fingerprint: input.input_fingerprint }, created_at: input.revised_at });
      return { kind: "revised", run_id: row.run_id as WorkflowRunId, record_version: resulting };
    });
  }

  async retry_unit(input: RetryRunUnit, retried_at: string): Promise<RetryRunUnitResult> {
    return this.sql.transaction(async (transaction) => {
      const unitRows = await transaction.query<{ readonly run_id: string; readonly stage_instance_id: string; readonly unit_id: string; readonly unit_state: RunUnit["state"]; readonly stage_state: RunStage["state"]; readonly run_state: WorkflowRun["state"]; readonly input_snapshot: readonly ArtifactEnvelope[]; readonly input_fingerprint: string; readonly record_version: string }>(`SELECT unit.run_id::text,unit.stage_instance_id::text,unit.unit_id,unit.state AS unit_state,
        stage.state AS stage_state,run.state AS run_state,unit.input_snapshot,unit.input_fingerprint,run.record_version::text
        FROM oakridge.run_unit unit JOIN oakridge.stage_instance stage ON stage.id=unit.stage_instance_id
        JOIN oakridge.workflow_run run ON run.id=unit.run_id WHERE unit.id=$1 FOR UPDATE OF unit,stage,run`, [input.run_unit_id]);
      const unit = unitRows[0];
      if (!unit) return { kind: "unit_not_found", detail: `run unit '${input.run_unit_id}' was not found` };
      const requestKey = `operator_retry:${input.idempotency_key}`;
      const replayRows = await transaction.query<WorkOrderRow>(`SELECT id::text,run_unit_id::text,reason,input_snapshot,input_fingerprint,state,workflow_id,request_idempotency_key,execution_request,created_at::text,completed_at::text
        FROM oakridge.work_order WHERE run_unit_id=$1 AND request_idempotency_key=$2 FOR UPDATE`, [input.run_unit_id, requestKey]);
      if (replayRows[0]) return { kind: "already_created", work_order: decodeOrder(replayRows[0]), run_id: unit.run_id as WorkflowRunId, record_version: Number(unit.record_version) as RunRecordVersion };
      if (unit.run_state !== "active" || unit.stage_state !== "active" || unit.unit_state === "satisfied" || unit.unit_state === "cancelled") {
        return { kind: "not_active", detail: `run unit '${input.run_unit_id}' is not active retryable work` };
      }
      const waits = await transaction.query<{ readonly id: string }>("SELECT id::text FROM oakridge.wait WHERE run_unit_id=$1 AND status='open' FOR UPDATE", [input.run_unit_id]);
      if (waits.length > 0) return { kind: "actionable_wait", detail: `run unit '${input.run_unit_id}' has an actionable wait` };
      const activeOrders = await transaction.query<{ readonly state: WorkOrder["state"]; readonly health: ExecutorHealthObservation | null }>(`SELECT work.state,attachment.health FROM oakridge.work_order work
        LEFT JOIN oakridge.executor_attachment attachment ON attachment.work_order_id=work.id
        WHERE work.run_unit_id=$1 AND work.state IN ('available','started') ORDER BY work.created_at DESC,work.id DESC FOR UPDATE OF work`, [input.run_unit_id]);
      const isRecordedMissingWork = activeOrders.every((order) => order.state === "started" && order.health !== null && order.health.kind !== "running");
      if (!isRecordedMissingWork) return { kind: "work_in_progress", detail: `run unit '${input.run_unit_id}' already has runnable or running work` };
      const missing = await transaction.query<{ readonly output_name: string }>("SELECT output_name FROM oakridge.run_output_slot WHERE run_unit_id=$1 AND required AND state <> 'released' FOR UPDATE", [input.run_unit_id]);
      if (missing.length === 0) return { kind: "no_missing_work", detail: `run unit '${input.run_unit_id}' has no missing required output` };
      const basisRows = await transaction.query<{ readonly capability_hash: string; readonly execution_request: ExecutionRequest | null }>(`SELECT capability_hash,execution_request FROM oakridge.work_order
        WHERE run_unit_id=$1 AND execution_request IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [input.run_unit_id]);
      const basis = basisRows[0];
      if (!basis?.execution_request) return { kind: "no_execution_basis", detail: `run unit '${input.run_unit_id}' has no resolved execution request` };
      const workOrderId = randomUUID() as WorkOrderId;
      const workflowId = `v2-work:${workOrderId}`;
      const executionRequest: ExecutionRequest = { ...basis.execution_request, execution_id: workOrderId as unknown as ExecutionRequest["execution_id"] };
      await transaction.query("UPDATE oakridge.work_order SET state='abandoned',completed_at=$2::timestamptz WHERE run_unit_id=$1 AND state IN ('available','started')", [input.run_unit_id, retried_at]);
      const rows = await transaction.query<WorkOrderRow>(`INSERT INTO oakridge.work_order
        (id,run_unit_id,reason,input_snapshot,input_fingerprint,state,workflow_id,request_idempotency_key,capability_hash,execution_request,created_at)
        VALUES ($1,$2,'operator_retry',$3::jsonb,$4,'available',$5,$6,$7,$8::jsonb,$9::timestamptz)
        RETURNING id::text,run_unit_id::text,reason,input_snapshot,input_fingerprint,state,workflow_id,request_idempotency_key,execution_request,created_at::text,completed_at::text`,
      [workOrderId, input.run_unit_id, JSON.stringify(unit.input_snapshot), unit.input_fingerprint, workflowId, requestKey, basis.capability_hash, executionRequest, retried_at]);
      const order = rows[0];
      if (!order) throw new Error("operator retry work order insert returned no row");
      await transaction.query("UPDATE oakridge.run_unit SET state='ready',outcome=NULL,ended_at=NULL WHERE id=$1", [input.run_unit_id]);
      const prior = Number(unit.record_version) as RunRecordVersion;
      const resulting = (Number(unit.record_version) + 1) as RunRecordVersion;
      await transaction.query("UPDATE oakridge.workflow_run SET record_version=$2 WHERE id=$1", [unit.run_id, resulting]);
      await insertTransition(transaction, { run_id: unit.run_id as WorkflowRunId, run_unit_id: input.run_unit_id, work_order_id: workOrderId, wait_id: null, output_name: null,
        operation: "operator_retry_created", actor: input.actor, prior_record_version: prior, resulting_record_version: resulting,
        detail: { idempotency_key: input.idempotency_key, missing_outputs: missing.map((slot) => slot.output_name) }, created_at: retried_at });
      return { kind: "created", work_order: decodeOrder(order), run_id: unit.run_id as WorkflowRunId, record_version: resulting };
    });
  }

  async admit_unit(request: AdmitStageUnitRequest, admitted_at: string): Promise<AdmitStageUnitResult> {
    return this.sql.transaction(async (transaction) => {
      const stageRows = await transaction.query<{ readonly run_id: string; readonly stage_state: string; readonly run_state: string; readonly manual_admission: boolean; readonly record_version: string }>(`SELECT stage.run_id::text, stage.state AS stage_state, run.state AS run_state, policy.manual_admission, run.record_version::text
        FROM oakridge.stage_instance stage JOIN oakridge.run_stage_scheduling_policy policy ON policy.stage_instance_id=stage.id
        JOIN oakridge.workflow_run run ON run.id=stage.run_id WHERE stage.id=$1 FOR UPDATE OF stage, policy, run`, [request.stage_instance_id]);
      const stage = stageRows[0];
      if (!stage) return { kind: "stage_not_found", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id };
      if (stage.stage_state !== "active" || stage.run_state !== "active") return { kind: "not_pending", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id };
      if (!stage.manual_admission) return { kind: "not_manual", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id };
      const unitRows = await transaction.query<{ readonly id: string; readonly admitted: boolean }>("SELECT id::text,admitted FROM oakridge.run_unit WHERE stage_instance_id=$1 AND unit_id=$2 FOR UPDATE", [request.stage_instance_id, request.unit_id]);
      const unit = unitRows[0];
      if (!unit) return { kind: "unit_not_found", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id };
      const requestHash = createHash("sha256").update(JSON.stringify({ unit_id: request.unit_id })).digest("hex");
      const commands = await transaction.query<{ readonly unit_id: string; readonly request_hash: string }>("SELECT unit_id,request_hash FROM oakridge.run_admission_command WHERE stage_instance_id=$1 AND idempotency_key=$2 FOR UPDATE", [request.stage_instance_id, request.idempotency_key]);
      if (commands[0]) {
        if (commands[0].unit_id !== request.unit_id || commands[0].request_hash !== requestHash) return { kind: "idempotency_conflict", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id };
        return { kind: "already_admitted", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id };
      }
      if (unit.admitted) return { kind: "already_admitted", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id };
      const blocked = await transaction.query<{ readonly unit_id: string }>(`SELECT edge.depends_on_unit_id AS unit_id FROM oakridge.run_unit_dependency edge
        LEFT JOIN oakridge.run_unit dependency ON dependency.stage_instance_id=edge.stage_instance_id AND dependency.unit_id=edge.depends_on_unit_id
        WHERE edge.stage_instance_id=$1 AND edge.unit_id=$2 AND (
          dependency.id IS NULL OR NOT (dependency.state='satisfied' AND NOT EXISTS (
            SELECT 1 FROM oakridge.run_output_slot slot WHERE slot.run_unit_id=dependency.id AND slot.required AND slot.state <> 'released'
          ))
        ) ORDER BY edge.depends_on_unit_id`, [request.stage_instance_id, request.unit_id]);
      if (blocked.length > 0) return { kind: "dependency_blocked", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id, blocked_by: blocked.map((row) => row.unit_id as UnitId) };
      await transaction.query("INSERT INTO oakridge.run_admission_command (stage_instance_id,unit_id,idempotency_key,request_hash,applied_at) VALUES ($1,$2,$3,$4,$5::timestamptz)",
        [request.stage_instance_id, request.unit_id, request.idempotency_key, requestHash, admitted_at]);
      await transaction.query("UPDATE oakridge.run_unit SET admitted=true,admitted_at=$3::timestamptz WHERE stage_instance_id=$1 AND unit_id=$2", [request.stage_instance_id, request.unit_id, admitted_at]);
      const prior = Number(stage.record_version) as RunRecordVersion;
      const resulting = (Number(stage.record_version) + 1) as RunRecordVersion;
      await transaction.query("UPDATE oakridge.workflow_run SET record_version=$2 WHERE id=$1", [stage.run_id, resulting]);
      await insertTransition(transaction, { run_id: stage.run_id as WorkflowRunId, run_unit_id: unit.id as RunUnitId, work_order_id: null, wait_id: null, output_name: null,
        operation: "unit_admitted", actor: "operator", prior_record_version: prior, resulting_record_version: resulting,
        detail: { idempotency_key: request.idempotency_key }, created_at: admitted_at });
      return { kind: "admitted", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id };
    });
  }

  async decide_run(run_id: WorkflowRunId, decided_at: string): Promise<Result<RunDecision, RunRecordRepositoryError>> {
    return this.sql.transaction(async (transaction) => {
      const runRows = await transaction.query<RunRow>(`SELECT run.id::text, run.workflow_definition_id::text, definition.version AS workflow_definition_version,
        run.context, run.state, run.outcome, run.record_version::text, run.created_at::text, run.ended_at::text
        FROM oakridge.workflow_run run JOIN oakridge.workflow_definition definition ON definition.id = run.workflow_definition_id
        WHERE run.id = $1 FOR UPDATE OF run`, [run_id]);
      const row = runRows[0];
      if (!row) return err({ operation: "decide_run", run_id, kind: "run_not_found", detail: `workflow run '${run_id}' was not found` });
      try {
        const run = decodeRun(row);
        if (run.state !== "active" && run.outcome) return ok({ kind: "complete", outcome: run.outcome });
        let currentVersion = run.record_version;
        const stageRows = await transaction.query<StageRow>(`SELECT id::text, run_id::text, stage_key, stage_contract, state, outcome, materialization_closed, started_at::text, ended_at::text FROM oakridge.stage_instance WHERE run_id = $1 AND attempt_root_workflow_id IS NULL ORDER BY stage_key FOR UPDATE`, [run_id]);
        const stageDecisions = [];
        for (const stageRow of stageRows) {
          const stage = decodeStage(stageRow);
          const unitRows = await transaction.query<UnitRow>(`SELECT id::text, run_id::text, stage_instance_id::text, unit_id, parameters, input_snapshot, input_fingerprint, state, admitted, admitted_at::text, outcome, created_at::text, ended_at::text FROM oakridge.run_unit WHERE stage_instance_id = $1 ORDER BY unit_id FOR UPDATE`, [stage.id]);
          const decidedUnits: { readonly unit: RunUnit; readonly decision: UnitDecision }[] = [];
          for (const unitRow of unitRows) {
            const unit = decodeUnit(unitRow);
            const slots = (await transaction.query<SlotRow>(`SELECT run_unit_id::text, output_name, collection_key, artifact_type, required, release_policy, state, artifact_revision_id::text, release_wait_id::text, invalidation_reason, state_changed_at::text, updated_by_work_order_id::text, version::text FROM oakridge.run_output_slot WHERE run_unit_id = $1 ORDER BY output_name, collection_key NULLS FIRST FOR UPDATE`, [unit.id])).map(decodeSlot);
            const orders = (await transaction.query<WorkOrderRow>(`SELECT id::text, run_unit_id::text, reason, input_snapshot, input_fingerprint, state, workflow_id, request_idempotency_key, created_at::text, completed_at::text FROM oakridge.work_order WHERE run_unit_id = $1 ORDER BY created_at, id FOR UPDATE`, [unit.id])).map(decodeOrder);
            const artifactIds = slots.flatMap((slot) => slot.state.kind === "released" ? [slot.state.artifact_revision_id] : []);
            const artifacts = artifactIds.length === 0 ? [] : (await transaction.query<ArtifactRow>(`SELECT id::text, run_id::text, stage_instance_id::text, execution_id, unit_id, output_name, collection_key, artifact_type, label, body, version, parent_artifact_id::text, released_at::text, created_at::text FROM oakridge.artifact WHERE id = ANY($1::uuid[])`, [artifactIds])).map(artifactRow);
            // Ownership of a v2 wait is `run_unit_id` — never the legacy
            // `execution_workflow_id` — so this is every wait still open on the
            // unit's own record, regardless of which work order opened it.
            const openWaits = (await transaction.query<WaitRow>(`SELECT ${waitColumns} FROM oakridge.wait wait WHERE wait.run_unit_id = $1 AND wait.status = 'open' ORDER BY wait.opened_at`, [unit.id])).map(decodeWait);
            const decision = selectUnitDecision({ unit, required_slots: slots.filter((slot) => slot.required), open_waits: openWaits, work_orders: orders, artifacts });
            if (decision.kind === "satisfied" && unit.state !== "satisfied") {
              await transaction.query("UPDATE oakridge.run_unit SET state = 'satisfied', outcome = '{\"kind\":\"succeeded\"}'::jsonb, ended_at = $2::timestamptz WHERE id = $1", [unit.id, decided_at]);
              await transaction.query("UPDATE oakridge.work_order SET state = 'completed', completed_at = $2::timestamptz WHERE run_unit_id = $1 AND state IN ('available','started')", [unit.id, decided_at]);
              const versions = await transaction.query<{ readonly record_version: string }>("UPDATE oakridge.workflow_run SET record_version = record_version + 1 WHERE id = $1 RETURNING record_version::text", [run_id]);
              const resultingVersion = Number(versions[0]?.record_version ?? currentVersion) as RunRecordVersion;
              await insertTransition(transaction, { run_id, run_unit_id: unit.id, work_order_id: null, wait_id: null, output_name: null,
                operation: "unit_satisfied", actor: "system", prior_record_version: currentVersion, resulting_record_version: resultingVersion, detail: {}, created_at: decided_at });
              currentVersion = resultingVersion;
            }
            decidedUnits.push({ unit, decision });
          }
          const dependencyRows = await transaction.query<{ readonly run_unit_id: string; readonly depends_on_run_unit_id: string | null; readonly depends_on_unit_id: string }>(`SELECT unit.id::text AS run_unit_id,dependency.id::text AS depends_on_run_unit_id,edge.depends_on_unit_id
            FROM oakridge.run_unit_dependency edge JOIN oakridge.run_unit unit ON unit.stage_instance_id=edge.stage_instance_id AND unit.unit_id=edge.unit_id
            LEFT JOIN oakridge.run_unit dependency ON dependency.stage_instance_id=edge.stage_instance_id AND dependency.unit_id=edge.depends_on_unit_id
            WHERE edge.stage_instance_id=$1 ORDER BY unit.unit_id,edge.depends_on_unit_id FOR UPDATE OF edge`, [stage.id]);
          const satisfied = new Set(decidedUnits.filter(({ decision }) => decision.kind === "satisfied").map(({ unit }) => String(unit.id)));
          const dependencies = new Map<string, string[]>();
          for (const edge of dependencyRows) dependencies.set(edge.run_unit_id, [...(dependencies.get(edge.run_unit_id) ?? []), edge.depends_on_run_unit_id ?? `unmaterialized:${edge.depends_on_unit_id}`]);
          const policyRows = await transaction.query<{ readonly max_parallel: number }>("SELECT max_parallel FROM oakridge.run_stage_scheduling_policy WHERE stage_instance_id = $1 FOR UPDATE", [stage.id]);
          const maxParallel = policyRows[0]?.max_parallel ?? Number.MAX_SAFE_INTEGER;
          const runningRows = await transaction.query<{ readonly count: string }>(`SELECT count(*)::text AS count FROM oakridge.work_order work
            JOIN oakridge.run_unit unit ON unit.id=work.run_unit_id WHERE unit.stage_instance_id=$1 AND work.state='started'
            AND NOT EXISTS (SELECT 1 FROM oakridge.wait wait WHERE wait.run_unit_id=unit.id AND wait.status='open')`, [stage.id]);
          const capacity = Math.max(0, maxParallel - Number(runningRows[0]?.count ?? 0));
          let selected = 0;
          const schedulable = decidedUnits.map(({ unit, decision }): UnitDecision => {
            if (decision.kind !== "work_available") return decision;
            const isReady = unit.admitted && (dependencies.get(String(unit.id)) ?? []).every((dependency) => satisfied.has(dependency));
            if (!isReady || selected >= capacity) return { kind: "waiting", waits: [] };
            selected += 1;
            return decision;
          });
          stageDecisions.push(selectStageDecision({ stage, units: schedulable }));
        }
        let decision = selectRunDecision({ run: { ...run, record_version: currentVersion }, stages: stageDecisions });
        if (decision.kind === "start_work") {
          const ids = decision.work_orders.map((order) => order.id);
          await transaction.query("UPDATE oakridge.work_order SET state = 'started' WHERE id = ANY($1::uuid[]) AND state = 'available'", [ids]);
          await transaction.query("UPDATE oakridge.run_unit SET state = 'working' WHERE id IN (SELECT run_unit_id FROM oakridge.work_order WHERE id = ANY($1::uuid[])) AND state = 'ready'", [ids]);
          const versions = await transaction.query<{ readonly record_version: string }>("UPDATE oakridge.workflow_run SET record_version = record_version + 1 WHERE id = $1 RETURNING record_version::text", [run_id]);
          const resultingVersion = Number(versions[0]?.record_version ?? currentVersion) as RunRecordVersion;
          for (const order of decision.work_orders) {
            await insertTransition(transaction, { run_id, run_unit_id: order.run_unit_id, work_order_id: order.id, wait_id: null, output_name: null,
              operation: "work_started", actor: "system", prior_record_version: currentVersion, resulting_record_version: resultingVersion, detail: {}, created_at: decided_at });
          }
          currentVersion = resultingVersion;
          decision = { ...decision, record_version: resultingVersion };
        } else if (decision.kind === "complete") {
          const state = decision.outcome.kind === "succeeded" ? "succeeded" : decision.outcome.kind;
          await transaction.query("UPDATE oakridge.stage_instance SET state = $2, outcome = $3::jsonb, ended_at = $4::timestamptz WHERE run_id = $1 AND state = 'active'", [run_id, state, decision.outcome, decided_at]);
          await transaction.query("UPDATE oakridge.workflow_run SET state = $2, outcome = $3::jsonb, ended_at = $4::timestamptz, record_version = record_version + 1 WHERE id = $1 AND state = 'active'", [run_id, state, decision.outcome, decided_at]);
        }
        return ok(decision);
      } catch (error) {
        return err({ operation: "decide_run", run_id, kind: "record_corrupt", detail: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  async find_work_order_execution(work_order_id: WorkOrderId): Promise<WorkOrderExecution | null> {
    const rows = await this.sql.query<WorkOrderRow & { readonly stage_instance_id: string; readonly unit_id: string; readonly parameters: JsonValue; readonly stage_contract: { readonly executor_type: string; readonly resolved_config: JsonValue; readonly outputs: readonly { readonly name: string; readonly artifact_type: string; readonly required: boolean; readonly release: OutputReleaseContract }[] } }>(`SELECT work.id::text, work.run_unit_id::text, work.reason, work.input_snapshot, work.input_fingerprint, work.state, work.workflow_id, work.request_idempotency_key, work.execution_request, work.created_at::text, work.completed_at::text,
      unit.stage_instance_id::text, unit.unit_id, unit.parameters, stage.stage_contract
      FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id = work.run_unit_id JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id WHERE work.id = $1`, [work_order_id]);
    const row = rows[0];
    if (!row) return null;
    const order = decodeOrder(row);
    if (row.execution_request) return { work_order: order, request: row.execution_request };
    const request: ExecutionRequest = { execution_id: order.id as unknown as ExecutionRequest["execution_id"], stage_instance_id: row.stage_instance_id as StageInstanceId, unit_id: row.unit_id as UnitId,
      executor_type: row.stage_contract.executor_type, resolved_config: row.stage_contract.resolved_config, inputs: order.input_snapshot,
      declared_outputs: row.stage_contract.outputs, expected_artifacts: row.stage_contract.outputs.filter((output) => output.required).map((output) => ({ unit_id: row.unit_id as UnitId, output_name: output.name, artifact_type: output.artifact_type })) };
    return { work_order: order, request };
  }

  async find_work_order_attachment(work_order_id: WorkOrderId): Promise<ExecutorAttachment | null> {
    const rows = await this.sql.query<ExecutorAttachmentRow>(`SELECT work_order_id::text,executor_type,external_reference,health,cleanup_state,updated_at::text
      FROM oakridge.executor_attachment WHERE work_order_id=$1`, [work_order_id]);
    const row = rows[0];
    return row ? { ...row, work_order_id: row.work_order_id as WorkOrderId } : null;
  }

  async publish_artifact(request: PublishWorkOrderArtifact): Promise<PublishWorkOrderArtifactResult> {
    return this.sql.transaction(async (transaction) => {
      // Keep the same outer-to-inner lock order as decide_run: run, then
      // unit/work, then slot. Locking the work order first and updating the
      // run last lets publication deadlock with a concurrent recovered ask
      // (ask owns run and waits for work; publication owns work and waits for
      // run). This first lookup is only routing; all authoritative fields are
      // read again under locks below.
      const ownerRows = await transaction.query<{ readonly run_id: string }>(`SELECT unit.run_id::text
        FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id = work.run_unit_id
        WHERE work.id = $1`, [request.work_order_id]);
      const owner = ownerRows[0];
      if (!owner) return { kind: "work_not_found", detail: `work order '${request.work_order_id}' was not found` };
      await transaction.query("SELECT id FROM oakridge.workflow_run WHERE id = $1 FOR UPDATE", [owner.run_id]);
      const workRows = await transaction.query<{ readonly work_state: WorkOrder["state"]; readonly capability_hash: string; readonly workflow_id: string; readonly run_unit_id: string; readonly run_id: string; readonly stage_instance_id: string; readonly unit_id: string }>(`SELECT work.state AS work_state, work.capability_hash, work.workflow_id, unit.id::text AS run_unit_id, unit.run_id::text, unit.stage_instance_id::text, unit.unit_id
        FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id = work.run_unit_id
        WHERE work.id = $1 FOR UPDATE OF work, unit`, [request.work_order_id]);
      const work = workRows[0];
      if (!work) return { kind: "work_not_found", detail: `work order '${request.work_order_id}' was not found` };
      if (work.capability_hash !== request.capability_hash) return { kind: "invalid_capability", detail: "work-order capability was not accepted" };
      const slotRows = await transaction.query<{ readonly artifact_type: string; readonly slot_state: SlotRow["state"]; readonly artifact_revision_id: string | null; readonly release_wait_id: string | null; readonly release_policy: OutputReleaseContract }>(
        "SELECT artifact_type, state AS slot_state, artifact_revision_id::text, release_wait_id::text, release_policy FROM oakridge.run_output_slot WHERE run_unit_id = $1 AND output_name = $2 AND collection_key IS NOT DISTINCT FROM $3 FOR UPDATE",
        [work.run_unit_id, request.output_name, request.collection_key ?? null]);
      const slot = slotRows[0];
      if (!slot) return { kind: "slot_not_found", detail: `output slot '${request.output_name}' was not declared` };
      const row = { ...work, ...slot };
      const replay = await transaction.query<{ readonly artifact_id: string; readonly emission_payload_hash: string }>("SELECT id::text AS artifact_id, emission_payload_hash FROM oakridge.artifact WHERE work_order_id = $1 AND output_name = $2 AND collection_key IS NOT DISTINCT FROM $3 AND emission_idempotency_key = $4", [request.work_order_id, request.output_name, request.collection_key ?? null, request.idempotency_key]);
      if (replay[0]) {
        if (replay[0].emission_payload_hash !== request.payload_hash) return { kind: "idempotency_conflict", artifact_id: replay[0].artifact_id as ArtifactId, detail: "idempotency key was already used with a different payload" };
        const version = await currentVersion(transaction, row.run_id as WorkflowRunId);
        return { kind: "already_applied", artifact_id: replay[0].artifact_id as ArtifactId, run_id: row.run_id as WorkflowRunId, record_version: version };
      }
      if (row.work_state === "abandoned") return { kind: "work_abandoned", detail: `work order '${request.work_order_id}' is abandoned` };
      if (row.slot_state === "invalidated") return { kind: "slot_invalidated", detail: `output slot '${request.output_name}' is invalidated` };
      if (row.slot_state === "released" && row.artifact_revision_id) return { kind: "slot_already_released", artifact_id: row.artifact_revision_id as ArtifactId, detail: `output slot '${request.output_name}' is already released` };
      // A different (non-replay) publish while the slot already has an open
      // wait: proceeding would try to open a second wait on the same slot,
      // which `wait_v2_open_slot` refuses — return the existing wait instead
      // of letting that surface as an unhandled constraint violation.
      if (row.slot_state === "pending" && row.release_wait_id) return { kind: "slot_pending", wait_id: row.release_wait_id as WaitId, detail: `output slot '${request.output_name}' is already pending a decision` };
      const release = row.release_policy;
      const immediate = release.kind === "immediate";
      const artifactUnitId = request.collection_key ?? row.unit_id;
      await transaction.query(`INSERT INTO oakridge.artifact
        (id, chain_id, run_id, stage_instance_id, execution_id, unit_id, output_name, collection_key, artifact_type, body, label, version, parent_artifact_id,
         emission_idempotency_key, emission_payload_hash, created_at, lifecycle_state, released_at, lifecycle_updated_at, attempt_workflow_id, work_order_id)
        VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$5,1,NULL,$10,$11,$12::timestamptz,$14,$15::timestamptz,$12::timestamptz,$4,$13)`,
        [request.artifact_id, row.run_id, row.stage_instance_id, request.work_order_id, artifactUnitId, request.output_name, request.collection_key ?? null, row.artifact_type, request.body, request.idempotency_key, request.payload_hash, request.published_at, request.work_order_id,
          immediate ? "released" : "current", immediate ? request.published_at : null]);
      await transaction.query(`INSERT INTO oakridge.artifact_emission_idempotency
        (stage_instance_id, execution_id, unit_id, output_name, collection_key, idempotency_key, payload_hash, artifact_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)`, [row.stage_instance_id, request.work_order_id, artifactUnitId, request.output_name, request.collection_key ?? null, request.idempotency_key, request.payload_hash, request.artifact_id, request.published_at]);

      if (immediate) {
        await transaction.query("UPDATE oakridge.run_output_slot SET state = 'released', artifact_revision_id = $3, release_wait_id = NULL, invalidation_reason = NULL, state_changed_at = $4::timestamptz, updated_by_work_order_id = $2, version = version + 1 WHERE run_unit_id = $1 AND output_name = $5 AND collection_key IS NOT DISTINCT FROM $6", [row.run_unit_id, request.work_order_id, request.artifact_id, request.published_at, request.output_name, request.collection_key ?? null]);
        const versions = await transaction.query<{ readonly record_version: string }>("UPDATE oakridge.workflow_run SET record_version = record_version + 1 WHERE id = $1 RETURNING record_version::text", [row.run_id]);
        const resultingVersion = Number(versions[0]?.record_version ?? 0) as RunRecordVersion;
        await insertTransition(transaction, { run_id: row.run_id as WorkflowRunId, run_unit_id: row.run_unit_id as RunUnitId, work_order_id: request.work_order_id, wait_id: null, output_name: request.output_name, collection_key: request.collection_key ?? null,
          operation: "slot_released", actor: `work_order:${request.work_order_id}`, prior_record_version: (resultingVersion - 1) as RunRecordVersion, resulting_record_version: resultingVersion, detail: { artifact_id: request.artifact_id }, created_at: request.published_at });
        return { kind: "published", artifact_id: request.artifact_id, run_id: row.run_id as WorkflowRunId, record_version: resultingVersion };
      }

      const waitId = randomUUID() as WaitId;
      const waitKind = release.kind === "gate" ? "gate" : "handoff_external";
      const closesOn: WaitClosesOn = release.kind === "gate"
        ? { kind: "gate", gate_step: release.steps[0]?.type ?? "review", actions: release.steps[0]?.actions.map((action) => action.name) ?? [] }
        : { kind: "handoff_external", external_wait_kind: release.external_wait_kind, decision_artifact_id: request.artifact_id };
      await transaction.query(
        `INSERT INTO oakridge.wait
           (id, stage_instance_id, unit_id, kind, artifact_revision_id, closes_on, status, run_unit_id, output_name, collection_key, execution_workflow_id, command_workflow_id, opened_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,'open',$7,$8,$9,$10,$11,$12::timestamptz)`,
        [waitId, row.stage_instance_id, row.unit_id, waitKind, request.artifact_id, closesOn, row.run_unit_id, request.output_name, request.collection_key ?? null, row.workflow_id,
          v2WaitCommandAddress(waitId), request.published_at],
      );
      await transaction.query("UPDATE oakridge.run_output_slot SET state = 'pending', artifact_revision_id = $3, release_wait_id = $6, invalidation_reason = NULL, state_changed_at = $4::timestamptz, updated_by_work_order_id = $2, version = version + 1 WHERE run_unit_id = $1 AND output_name = $5 AND collection_key IS NOT DISTINCT FROM $7", [row.run_unit_id, request.work_order_id, request.artifact_id, request.published_at, request.output_name, waitId, request.collection_key ?? null]);
      const versions = await transaction.query<{ readonly record_version: string }>("UPDATE oakridge.workflow_run SET record_version = record_version + 1 WHERE id = $1 RETURNING record_version::text", [row.run_id]);
      const resultingVersion = Number(versions[0]?.record_version ?? 0) as RunRecordVersion;
      await insertTransition(transaction, { run_id: row.run_id as WorkflowRunId, run_unit_id: row.run_unit_id as RunUnitId, work_order_id: request.work_order_id, wait_id: waitId, output_name: request.output_name, collection_key: request.collection_key ?? null,
        operation: "slot_pending", actor: `work_order:${request.work_order_id}`, prior_record_version: (resultingVersion - 1) as RunRecordVersion, resulting_record_version: resultingVersion, detail: { artifact_id: request.artifact_id, release_kind: release.kind }, created_at: request.published_at });
      return { kind: "pending", artifact_id: request.artifact_id, wait_id: waitId, run_id: row.run_id as WorkflowRunId, record_version: resultingVersion };
    });
  }

  async close_output_wait(request: CloseRunOutputWait): Promise<CloseRunOutputWaitResult> {
    return this.sql.transaction((transaction) => this.closeOutputWaitTransaction(transaction, request));
  }

  private async closeOutputWaitTransaction(transaction: SqlExecutor, request: CloseRunOutputWait): Promise<CloseRunOutputWaitResult> {
      const ownerRows = await transaction.query<{ readonly run_id: string }>(`SELECT unit.run_id::text FROM oakridge.wait wait
        JOIN oakridge.run_unit unit ON unit.id=wait.run_unit_id WHERE wait.id=$1 AND wait.run_unit_id IS NOT NULL`, [request.wait_id]);
      if (!ownerRows[0]) return { kind: "wait_not_found", detail: `v2 wait '${request.wait_id}' was not found` };
      await transaction.query("SELECT id FROM oakridge.workflow_run WHERE id=$1 FOR UPDATE", [ownerRows[0].run_id]);
      const waitRows = await transaction.query<{ readonly status: "open" | "closed"; readonly kind: WaitClosesOn["kind"]; readonly outcome: WaitOutcome | null; readonly run_unit_id: string | null; readonly output_name: string | null; readonly collection_key: string | null; readonly run_id: string }>(
        `SELECT wait.status, wait.kind, wait.outcome, wait.run_unit_id::text, wait.output_name, wait.collection_key, unit.run_id::text
         FROM oakridge.wait wait JOIN oakridge.run_unit unit ON unit.id = wait.run_unit_id
         WHERE wait.id = $1 AND wait.run_unit_id IS NOT NULL FOR UPDATE OF wait`, [request.wait_id]);
      const wait = waitRows[0];
      if (!wait || !wait.run_unit_id || !wait.output_name) return { kind: "wait_not_found", detail: `v2 wait '${request.wait_id}' was not found` };
      const releaseOutcome: WaitOutcome = wait.kind === "handoff_external"
        ? { kind: "external_completed", correlation_id: request.detail ?? request.actor }
        : { kind: "decided", action: request.action ?? "release", decision_artifact_id: null, feedback: request.detail };
      const invalidateOutcome: WaitOutcome = wait.kind === "handoff_external"
        ? { kind: "withdrawn" }
        : { kind: "decided", action: request.action ?? (request.disposition === "fail" ? "fail" : "invalidate"), decision_artifact_id: null, feedback: request.detail };
      const requestedOutcome = request.disposition === "release" ? releaseOutcome : invalidateOutcome;
      // `decided` is shared by both dispositions on a gate wait, so a match
      // must also agree on `action` — comparing `kind` alone would absorb a
      // retried "release" into an already-recorded "invalidate".
      const sameOutcome = (existing: WaitOutcome, requested: WaitOutcome): boolean =>
        existing.kind === requested.kind && (existing.kind !== "decided" || requested.kind !== "decided" || existing.action === requested.action);
      if (wait.status === "closed") {
        if (wait.outcome && sameOutcome(wait.outcome, requestedOutcome)) return { kind: "already_applied", run_id: wait.run_id as WorkflowRunId, record_version: await currentVersion(transaction, wait.run_id as WorkflowRunId) };
        return { kind: "wait_conflict", detail: `wait '${request.wait_id}' is already closed under a different disposition` };
      }
      const slotRows = await transaction.query<{ readonly slot_state: SlotRow["state"]; readonly artifact_revision_id: string | null; readonly updated_by_work_order_id: string | null }>(
        "SELECT state AS slot_state, artifact_revision_id::text, updated_by_work_order_id::text FROM oakridge.run_output_slot WHERE run_unit_id = $1 AND output_name = $2 AND collection_key IS NOT DISTINCT FROM $3 FOR UPDATE",
        [wait.run_unit_id, wait.output_name, wait.collection_key]);
      const slot = slotRows[0];
      if (!slot || slot.slot_state !== "pending" || !slot.artifact_revision_id) return { kind: "wait_conflict", detail: `output slot for wait '${request.wait_id}' is not pending` };
      await transaction.query("UPDATE oakridge.wait SET status = 'closed', outcome = $2::jsonb, closed_at = $3::timestamptz WHERE id = $1", [request.wait_id, requestedOutcome, request.decided_at]);
      if (request.disposition === "release") {
        await transaction.query("UPDATE oakridge.run_output_slot SET state = 'released', release_wait_id = NULL, invalidation_reason = NULL, state_changed_at = $3::timestamptz, version = version + 1 WHERE run_unit_id = $1 AND output_name = $2 AND collection_key IS NOT DISTINCT FROM $4", [wait.run_unit_id, wait.output_name, request.decided_at, wait.collection_key]);
        await transaction.query("UPDATE oakridge.artifact SET lifecycle_state = 'released', released_at = $2::timestamptz, lifecycle_updated_at = $2::timestamptz WHERE id = $1 AND lifecycle_state = 'current'", [slot.artifact_revision_id, request.decided_at]);
      } else {
        const reason = { kind: "operator", detail: request.detail ?? "invalidated" };
        await transaction.query("UPDATE oakridge.run_output_slot SET state = 'invalidated', release_wait_id = NULL, invalidation_reason = $3::jsonb, state_changed_at = $4::timestamptz, version = version + 1 WHERE run_unit_id = $1 AND output_name = $2 AND collection_key IS NOT DISTINCT FROM $5", [wait.run_unit_id, wait.output_name, reason, request.decided_at, wait.collection_key]);
        // The work order that produced the rejected artifact has nothing left
        // to do — its business work is over, not merely paused. Leaving it
        // `started` would make `selectUnitDecision` read the unit as
        // perpetually `work_in_progress` for a workflow that already returned.
        // A new work order (Slice 5's operator retry) is a separate decision.
        if (slot.updated_by_work_order_id) {
          await transaction.query("UPDATE oakridge.work_order SET state = 'abandoned', completed_at = $2::timestamptz WHERE id = $1 AND state IN ('available','started')", [slot.updated_by_work_order_id, request.decided_at]);
        }
        if (request.disposition === "fail") {
          const failure = { kind: "failed" as const, code: "gate_rejected", detail: request.detail ?? `gate action '${request.action ?? "fail"}' rejected the unit` };
          await transaction.query("UPDATE oakridge.run_unit SET state='failed',outcome=$2::jsonb,ended_at=$3::timestamptz WHERE id=$1 AND state NOT IN ('satisfied','failed','cancelled')", [wait.run_unit_id, failure, request.decided_at]);
        }
      }
      const versions = await transaction.query<{ readonly record_version: string }>("UPDATE oakridge.workflow_run SET record_version = record_version + 1 WHERE id = $1 RETURNING record_version::text", [wait.run_id]);
      const resultingVersion = Number(versions[0]?.record_version ?? 0) as RunRecordVersion;
      await insertTransition(transaction, { run_id: wait.run_id as WorkflowRunId, run_unit_id: wait.run_unit_id as RunUnitId, work_order_id: null, wait_id: request.wait_id, output_name: wait.output_name, collection_key: wait.collection_key as OutputCollectionKey | null,
        operation: request.disposition === "release" ? "slot_released" : "slot_invalidated", actor: request.actor,
        prior_record_version: (resultingVersion - 1) as RunRecordVersion, resulting_record_version: resultingVersion, detail: { via: "wait_close" }, created_at: request.decided_at });
      return request.disposition === "release"
        ? { kind: "released", artifact_id: slot.artifact_revision_id as ArtifactId, run_id: wait.run_id as WorkflowRunId, record_version: resultingVersion }
        : { kind: "invalidated", run_id: wait.run_id as WorkflowRunId, record_version: resultingVersion };
  }

  async decide_gate_wait(request: { readonly wait_id: WaitId; readonly action: string; readonly actor: string; readonly detail: string | null; readonly decided_at: string }): Promise<CloseRunOutputWaitResult> {
    try {
      return await this.sql.transaction(async (transaction) => {
        const rows = await transaction.query<{ readonly run_unit_id: string; readonly release_policy: OutputReleaseContract }>(`SELECT wait.run_unit_id::text,slot.release_policy
          FROM oakridge.wait wait JOIN oakridge.run_output_slot slot ON slot.run_unit_id=wait.run_unit_id
            AND slot.output_name=wait.output_name AND slot.collection_key IS NOT DISTINCT FROM wait.collection_key
          WHERE wait.id=$1 AND wait.kind='gate' AND wait.run_unit_id IS NOT NULL`, [request.wait_id]);
        const subject = rows[0]; const release = subject?.release_policy;
        if (!subject || !release || release.kind !== "gate") return { kind: "wait_not_found", detail: `v2 gate wait '${request.wait_id}' was not found` };
        const action = release.steps.flatMap((step) => step.actions).find((candidate) => candidate.name === request.action);
        if (!action) return { kind: "wait_conflict", detail: `action '${request.action}' is not allowed for wait '${request.wait_id}'` };
        const disposition: RunOutputWaitDisposition = action.disposition === "release" ? "release" : action.disposition === "revise" ? "invalidate" : "fail";
        const own = await this.closeOutputWaitTransaction(transaction, { ...request, disposition });
        if (own.kind === "wait_conflict" || own.kind === "wait_not_found") throw new GateCoordinationConflict(own);
        if (disposition !== "release" && release.revision_target === "upstream_handoff") {
          const upstreamRows = await transaction.query<{ readonly wait_id: string }>(`SELECT wait.id::text AS wait_id
            FROM oakridge.run_unit unit CROSS JOIN LATERAL jsonb_array_elements(unit.input_snapshot) input(value)
            JOIN oakridge.wait wait ON wait.artifact_revision_id=(input.value->>'artifact_id')::uuid
            WHERE unit.id=$1 AND wait.kind='handoff_external' AND wait.run_unit_id IS NOT NULL ORDER BY wait.id FOR UPDATE OF wait`, [subject.run_unit_id]);
          if (upstreamRows.length === 0) throw new GateCoordinationConflict({ kind: "wait_conflict", detail: "gate revision target has no run-owned upstream handoff" });
          for (const upstream of upstreamRows) {
            const result = await this.closeOutputWaitTransaction(transaction, { wait_id: upstream.wait_id as WaitId,
              disposition: "invalidate", action: request.action, actor: request.actor, detail: request.detail, decided_at: request.decided_at });
            if (result.kind === "wait_conflict" || result.kind === "wait_not_found") throw new GateCoordinationConflict(result);
          }
        }
        return own;
      });
    } catch (cause) {
      if (cause instanceof GateCoordinationConflict) return cause.result;
      throw cause;
    }
  }

  async complete_handoff_artifact(request: { readonly artifact_id: ArtifactId; readonly external_kind: string; readonly actor: string; readonly correlation_id: string; readonly decided_at: string }): Promise<CloseRunOutputWaitResult> {
    const rows = await this.sql.query<{ readonly wait_id: string; readonly release_policy: OutputReleaseContract }>(`SELECT wait.id::text AS wait_id,slot.release_policy
      FROM oakridge.wait wait JOIN oakridge.run_output_slot slot ON slot.run_unit_id=wait.run_unit_id
        AND slot.output_name=wait.output_name AND slot.collection_key IS NOT DISTINCT FROM wait.collection_key
      WHERE wait.artifact_revision_id=$1 AND wait.kind='handoff_external' AND wait.run_unit_id IS NOT NULL
      ORDER BY wait.opened_at DESC LIMIT 1`, [request.artifact_id]);
    const row = rows[0];
    if (!row || row.release_policy.kind !== "handoff") return { kind: "wait_not_found", detail: `v2 handoff for artifact '${request.artifact_id}' was not found` };
    if (row.release_policy.external_wait_kind !== request.external_kind) return { kind: "wait_conflict", detail: "external completion kind does not match the handoff policy" };
    return this.close_output_wait({ wait_id: row.wait_id as WaitId, disposition: "release", actor: request.actor,
      detail: request.correlation_id, decided_at: request.decided_at });
  }

  async ensure_executor_attachment(work_order_id: WorkOrderId, executor_type: string, updated_at: string): Promise<ExecutorAttachment> {
    const inserted = await this.sql.query<ExecutorAttachmentRow>(`INSERT INTO oakridge.executor_attachment (work_order_id, executor_type, updated_at)
      VALUES ($1,$2,$3::timestamptz) ON CONFLICT (work_order_id) DO NOTHING
      RETURNING work_order_id::text, executor_type, external_reference, health, cleanup_state, updated_at::text`, [work_order_id, executor_type, updated_at]);
    const row = inserted[0] ?? (await this.sql.query<ExecutorAttachmentRow>(
      `SELECT work_order_id::text, executor_type, external_reference, health, cleanup_state, updated_at::text
       FROM oakridge.executor_attachment WHERE work_order_id = $1`, [work_order_id]))[0];
    if (!row) throw new Error(`executor attachment for work order '${work_order_id}' disappeared after ensure`);
    if (row.executor_type !== executor_type) throw new Error(`work order '${work_order_id}' is attached to a different executor`);
    return { ...row, work_order_id: row.work_order_id as WorkOrderId };
  }

  async attach_external(work_order_id: WorkOrderId, reference: ExternalExecutionReference, updated_at: string): Promise<void> {
    await this.sql.query("UPDATE oakridge.executor_attachment SET external_reference = $2::jsonb, health = '{\"kind\":\"running\"}'::jsonb || jsonb_build_object('observed_at',$3::text), updated_at = $3::timestamptz WHERE work_order_id = $1", [work_order_id, reference, updated_at]);
  }
  async observe_executor(work_order_id: WorkOrderId, health: ExecutorHealthObservation, updated_at: string): Promise<void> { await this.sql.query("UPDATE oakridge.executor_attachment SET health = $2::jsonb, updated_at = $3::timestamptz WHERE work_order_id = $1", [work_order_id, health, updated_at]); }
  async request_cleanup(work_order_id: WorkOrderId, updated_at: string): Promise<void> { await this.sql.query("UPDATE oakridge.executor_attachment SET cleanup_state = 'requested', updated_at = $2::timestamptz WHERE work_order_id = $1 AND cleanup_state IN ('not_needed','failed')", [work_order_id, updated_at]); }
  async finish_cleanup(work_order_id: WorkOrderId, succeeded: boolean, updated_at: string): Promise<void> { await this.sql.query("UPDATE oakridge.executor_attachment SET cleanup_state = $2, updated_at = $3::timestamptz WHERE work_order_id = $1", [work_order_id, succeeded ? "complete" : "failed", updated_at]); }
}

const currentVersion = async (transaction: SqlExecutor, run_id: WorkflowRunId): Promise<RunRecordVersion> => {
  const rows = await transaction.query<{ readonly record_version: string }>("SELECT record_version::text FROM oakridge.workflow_run WHERE id = $1", [run_id]);
  return Number(rows[0]?.record_version ?? 0) as RunRecordVersion;
};
