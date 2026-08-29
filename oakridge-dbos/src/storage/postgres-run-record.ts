import { randomUUID } from "node:crypto";

import type { ArtifactRevision } from "../domain/artifacts";
import type { OutputReleaseContract } from "../domain/compiled-workflow";
import type { ArtifactEnvelope, ExecutionRequest, ExternalExecutionReference } from "../domain/execution";
import { err, ok, type ArtifactId, type InputFingerprint, type JsonValue, type OutputSlotVersion, type Result, type RunRecordVersion, type RunTransitionId, type RunUnitId, type StageInstanceId, type UnitId, type WaitId, type WorkflowDefinitionId, type WorkflowRunId, type WorkOrderId } from "../domain/primitives";
import { selectRunDecision, selectStageDecision, selectUnitDecision } from "../domain/run-decisions";
import type { CloseRunOutputWait, CloseRunOutputWaitResult, ExecutorAttachment, ExecutorHealthObservation, InitializeStraightThroughRun, PublishWorkOrderArtifact, PublishWorkOrderArtifactResult, RunDecision, RunOutputSlot, RunStage, RunTransitionOperation, RunUnit, UnitDecision, WorkflowRun, WorkOrder, WorkOrderExecution } from "../domain/run-record";
import type { WaitClosesOn, WaitOutcome } from "../domain/wait";
import type { StageOutcome } from "../domain/workflow";
import { decodeWait, waitColumns, type WaitRow } from "./postgres-wait";
import type { RunRecordRepository, RunRecordRepositoryError } from "./repositories";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";

interface RunRow { readonly id: string; readonly workflow_definition_id: string; readonly workflow_definition_version: number; readonly context: JsonValue; readonly state: WorkflowRun["state"]; readonly outcome: StageOutcome | null; readonly record_version: string; readonly created_at: string; readonly ended_at: string | null }
interface StageRow { readonly id: string; readonly run_id: string; readonly stage_key: string; readonly stage_contract: JsonValue; readonly state: RunStage["state"]; readonly outcome: StageOutcome | null; readonly materialization_closed: boolean; readonly started_at: string; readonly ended_at: string | null }
interface UnitRow { readonly id: string; readonly run_id: string; readonly stage_instance_id: string; readonly unit_id: string; readonly parameters: JsonValue; readonly input_snapshot: readonly ArtifactEnvelope[]; readonly input_fingerprint: string; readonly state: RunUnit["state"]; readonly outcome: StageOutcome | null; readonly created_at: string; readonly ended_at: string | null }
interface SlotRow { readonly run_unit_id: string; readonly output_name: string; readonly artifact_type: string; readonly required: boolean; readonly release_policy: OutputReleaseContract; readonly state: "empty" | "pending" | "released" | "invalidated"; readonly artifact_revision_id: string | null; readonly release_wait_id: string | null; readonly invalidation_reason: RunOutputSlot["state"] extends { kind: "invalidated"; reason: infer Reason } ? Reason : never; readonly state_changed_at: string | null; readonly updated_by_work_order_id: string | null; readonly version: string }
interface WorkOrderRow { readonly id: string; readonly run_unit_id: string; readonly reason: WorkOrder["reason"]; readonly input_snapshot: readonly ArtifactEnvelope[]; readonly input_fingerprint: string; readonly state: WorkOrder["state"]; readonly workflow_id: string; readonly request_idempotency_key: string; readonly created_at: string; readonly completed_at: string | null }
interface ArtifactRow { readonly id: string; readonly run_id: string; readonly stage_instance_id: string; readonly execution_id: string; readonly unit_id: string; readonly output_name: string; readonly artifact_type: string; readonly label: string | null; readonly body: JsonValue; readonly version: number; readonly parent_artifact_id: string | null; readonly released_at: string; readonly created_at: string }
interface ExecutorAttachmentRow { readonly work_order_id: string; readonly executor_type: string; readonly external_reference: ExternalExecutionReference | null; readonly health: ExecutorHealthObservation | null; readonly cleanup_state: ExecutorAttachment["cleanup_state"]; readonly updated_at: string }
interface StoredOutputContracts { readonly [output_name: string]: { readonly artifact_type: string; readonly required: boolean; readonly release: OutputReleaseContract } }

const decodeRun = (row: RunRow): WorkflowRun => ({ ...row, id: row.id as WorkflowRunId, workflow_definition_id: row.workflow_definition_id as WorkflowDefinitionId, record_version: Number(row.record_version) as RunRecordVersion });
const decodeStage = (row: StageRow): RunStage => ({ id: row.id as StageInstanceId, run_id: row.run_id as WorkflowRunId, stage_key: row.stage_key, contract: row.stage_contract, state: row.state, outcome: row.outcome, materialization_closed: row.materialization_closed, created_at: row.started_at, ended_at: row.ended_at });
const decodeUnit = (row: UnitRow): RunUnit => ({ ...row, id: row.id as RunUnitId, run_id: row.run_id as WorkflowRunId, stage_instance_id: row.stage_instance_id as StageInstanceId, unit_id: row.unit_id as UnitId, input_fingerprint: row.input_fingerprint as InputFingerprint });
const decodeOrder = (row: WorkOrderRow): WorkOrder => ({ ...row, id: row.id as WorkOrderId, run_unit_id: row.run_unit_id as RunUnitId, input_fingerprint: row.input_fingerprint as InputFingerprint });
const decodeSlot = (row: SlotRow): RunOutputSlot => {
  const base = { run_unit_id: row.run_unit_id as RunUnitId, output_name: row.output_name, artifact_type: row.artifact_type, required: row.required, release: row.release_policy, updated_by_work_order_id: row.updated_by_work_order_id as WorkOrderId | null, version: Number(row.version) as OutputSlotVersion };
  if (row.state === "empty") return { ...base, state: { kind: "empty" } };
  if (row.state === "pending" && row.artifact_revision_id && row.release_wait_id && row.state_changed_at) return { ...base, state: { kind: "pending", artifact_revision_id: row.artifact_revision_id as ArtifactId, release_wait_id: row.release_wait_id as RunOutputSlot["state"] extends { kind: "pending"; release_wait_id: infer Id } ? Id : never, pending_at: row.state_changed_at } };
  if (row.state === "released" && row.artifact_revision_id && row.state_changed_at) return { ...base, state: { kind: "released", artifact_revision_id: row.artifact_revision_id as ArtifactId, released_at: row.state_changed_at } };
  if (row.state === "invalidated" && row.invalidation_reason && row.state_changed_at) return { ...base, state: { kind: "invalidated", previous_artifact_revision_id: row.artifact_revision_id as ArtifactId | null, reason: row.invalidation_reason, invalidated_at: row.state_changed_at } };
  throw new Error(`output slot '${row.run_unit_id}:${row.output_name}' has an invalid '${row.state}' shape`);
};

const artifactRow = (row: ArtifactRow): ArtifactRevision => ({ id: row.id as ArtifactId, chain_id: row.id as ArtifactId, run_id: row.run_id as WorkflowRunId, stage_instance_id: row.stage_instance_id as StageInstanceId, execution_id: row.execution_id as ExecutionRequest["execution_id"], unit_id: row.unit_id as UnitId, output_name: row.output_name, artifact_type: row.artifact_type, label: row.label, body: row.body, version: row.version, parent_artifact_id: row.parent_artifact_id as ArtifactId | null, lifecycle: { kind: "released", released_at: row.released_at }, created_at: row.created_at });

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
       (id, run_id, run_unit_id, work_order_id, wait_id, output_name, operation, actor, prior_record_version, resulting_record_version, detail, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz)`,
    [randomUUID() as RunTransitionId, input.run_id, input.run_unit_id, input.work_order_id, input.wait_id, input.output_name,
      input.operation, input.actor, input.prior_record_version, input.resulting_record_version, input.detail, input.created_at],
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
        input.parameters, input.input_snapshot, input.input_fingerprint, input.work_order_id, input.work_order_workflow_id,
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
        ON CONFLICT (stage_instance_id, unit_id) DO NOTHING`, [input.run_unit_id, input.run_id, input.stage_instance_id, input.unit_id, input.parameters, input.input_snapshot, input.input_fingerprint, input.created_at]);
      for (const output of input.outputs) await transaction.query(`INSERT INTO oakridge.run_output_slot
        (run_unit_id, output_name, artifact_type, required, release_policy, state)
        VALUES ($1,$2,$3,$4,$5::jsonb,'empty') ON CONFLICT (run_unit_id, output_name) DO NOTHING`, [input.run_unit_id, output.name, output.artifact_type, output.required, output.release]);
      await transaction.query(`INSERT INTO oakridge.work_order
        (id, run_unit_id, reason, input_snapshot, input_fingerprint, state, workflow_id, request_idempotency_key, capability_hash, created_at)
        VALUES ($1,$2,'initial',$3::jsonb,$4,'available',$5,'initial',$6,$7::timestamptz)
        ON CONFLICT (run_unit_id, request_idempotency_key) DO NOTHING`, [input.work_order_id, input.run_unit_id, input.input_snapshot, input.input_fingerprint, input.work_order_workflow_id, input.work_order_capability_hash, input.created_at]);
      await transaction.query("UPDATE oakridge.workflow_run SET record_version = record_version + 1 WHERE id = $1", [input.run_id]);
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
        const stageRows = await transaction.query<StageRow>(`SELECT id::text, run_id::text, stage_key, stage_contract, state, outcome, materialization_closed, started_at::text, ended_at::text FROM oakridge.stage_instance WHERE run_id = $1 ORDER BY stage_key FOR UPDATE`, [run_id]);
        const stageDecisions = [];
        for (const stageRow of stageRows) {
          const stage = decodeStage(stageRow);
          const unitRows = await transaction.query<UnitRow>(`SELECT id::text, run_id::text, stage_instance_id::text, unit_id, parameters, input_snapshot, input_fingerprint, state, outcome, created_at::text, ended_at::text FROM oakridge.run_unit WHERE stage_instance_id = $1 ORDER BY unit_id FOR UPDATE`, [stage.id]);
          const unitDecisions: UnitDecision[] = [];
          for (const unitRow of unitRows) {
            const unit = decodeUnit(unitRow);
            const slots = (await transaction.query<SlotRow>(`SELECT run_unit_id::text, output_name, artifact_type, required, release_policy, state, artifact_revision_id::text, release_wait_id::text, invalidation_reason, state_changed_at::text, updated_by_work_order_id::text, version::text FROM oakridge.run_output_slot WHERE run_unit_id = $1 ORDER BY output_name FOR UPDATE`, [unit.id])).map(decodeSlot);
            const orders = (await transaction.query<WorkOrderRow>(`SELECT id::text, run_unit_id::text, reason, input_snapshot, input_fingerprint, state, workflow_id, request_idempotency_key, created_at::text, completed_at::text FROM oakridge.work_order WHERE run_unit_id = $1 ORDER BY created_at, id FOR UPDATE`, [unit.id])).map(decodeOrder);
            const artifactIds = slots.flatMap((slot) => slot.state.kind === "released" ? [slot.state.artifact_revision_id] : []);
            const artifacts = artifactIds.length === 0 ? [] : (await transaction.query<ArtifactRow>(`SELECT id::text, run_id::text, stage_instance_id::text, execution_id, unit_id, output_name, artifact_type, label, body, version, parent_artifact_id::text, released_at::text, created_at::text FROM oakridge.artifact WHERE id = ANY($1::uuid[])`, [artifactIds])).map(artifactRow);
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
            unitDecisions.push(decision);
          }
          stageDecisions.push(selectStageDecision({ stage, units: unitDecisions }));
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
    const rows = await this.sql.query<WorkOrderRow & { readonly stage_instance_id: string; readonly unit_id: string; readonly parameters: JsonValue; readonly stage_contract: { readonly executor_type: string; readonly resolved_config: JsonValue; readonly outputs: readonly { readonly name: string; readonly artifact_type: string; readonly required: boolean; readonly release: OutputReleaseContract }[] } }>(`SELECT work.id::text, work.run_unit_id::text, work.reason, work.input_snapshot, work.input_fingerprint, work.state, work.workflow_id, work.request_idempotency_key, work.created_at::text, work.completed_at::text,
      unit.stage_instance_id::text, unit.unit_id, unit.parameters, stage.stage_contract
      FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id = work.run_unit_id JOIN oakridge.stage_instance stage ON stage.id = unit.stage_instance_id WHERE work.id = $1`, [work_order_id]);
    const row = rows[0];
    if (!row) return null;
    const order = decodeOrder(row);
    const request: ExecutionRequest = { execution_id: order.id as unknown as ExecutionRequest["execution_id"], stage_instance_id: row.stage_instance_id as StageInstanceId, unit_id: row.unit_id as UnitId,
      executor_type: row.stage_contract.executor_type, resolved_config: row.stage_contract.resolved_config, inputs: order.input_snapshot,
      declared_outputs: row.stage_contract.outputs, expected_artifacts: row.stage_contract.outputs.filter((output) => output.required).map((output) => ({ unit_id: row.unit_id as UnitId, output_name: output.name, artifact_type: output.artifact_type })) };
    return { work_order: order, request };
  }

  async publish_artifact(request: PublishWorkOrderArtifact): Promise<PublishWorkOrderArtifactResult> {
    return this.sql.transaction(async (transaction) => {
      const workRows = await transaction.query<{ readonly work_state: WorkOrder["state"]; readonly capability_hash: string; readonly workflow_id: string; readonly run_unit_id: string; readonly run_id: string; readonly stage_instance_id: string; readonly unit_id: string }>(`SELECT work.state AS work_state, work.capability_hash, work.workflow_id, unit.id::text AS run_unit_id, unit.run_id::text, unit.stage_instance_id::text, unit.unit_id
        FROM oakridge.work_order work JOIN oakridge.run_unit unit ON unit.id = work.run_unit_id
        WHERE work.id = $1 FOR UPDATE OF work, unit`, [request.work_order_id]);
      const work = workRows[0];
      if (!work) return { kind: "work_not_found", detail: `work order '${request.work_order_id}' was not found` };
      if (work.capability_hash !== request.capability_hash) return { kind: "invalid_capability", detail: "work-order capability was not accepted" };
      const slotRows = await transaction.query<{ readonly artifact_type: string; readonly slot_state: SlotRow["state"]; readonly artifact_revision_id: string | null; readonly release_wait_id: string | null; readonly release_policy: OutputReleaseContract }>(
        "SELECT artifact_type, state AS slot_state, artifact_revision_id::text, release_wait_id::text, release_policy FROM oakridge.run_output_slot WHERE run_unit_id = $1 AND output_name = $2 FOR UPDATE",
        [work.run_unit_id, request.output_name]);
      const slot = slotRows[0];
      if (!slot) return { kind: "slot_not_found", detail: `output slot '${request.output_name}' was not declared` };
      const row = { ...work, ...slot };
      const replay = await transaction.query<{ readonly artifact_id: string; readonly emission_payload_hash: string }>("SELECT id::text AS artifact_id, emission_payload_hash FROM oakridge.artifact WHERE work_order_id = $1 AND output_name = $2 AND emission_idempotency_key = $3", [request.work_order_id, request.output_name, request.idempotency_key]);
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
      await transaction.query(`INSERT INTO oakridge.artifact
        (id, chain_id, run_id, stage_instance_id, execution_id, unit_id, output_name, artifact_type, body, label, version, parent_artifact_id,
         emission_idempotency_key, emission_payload_hash, created_at, lifecycle_state, released_at, lifecycle_updated_at, attempt_workflow_id, work_order_id)
        VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$5,1,NULL,$9,$10,$11::timestamptz,$13,$14::timestamptz,$11::timestamptz,$4,$12)`,
        [request.artifact_id, row.run_id, row.stage_instance_id, request.work_order_id, row.unit_id, request.output_name, row.artifact_type, request.body, request.idempotency_key, request.payload_hash, request.published_at, request.work_order_id,
          immediate ? "released" : "current", immediate ? request.published_at : null]);
      await transaction.query(`INSERT INTO oakridge.artifact_emission_idempotency
        (stage_instance_id, execution_id, unit_id, output_name, idempotency_key, payload_hash, artifact_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`, [row.stage_instance_id, request.work_order_id, row.unit_id, request.output_name, request.idempotency_key, request.payload_hash, request.artifact_id, request.published_at]);

      if (immediate) {
        await transaction.query("UPDATE oakridge.run_output_slot SET state = 'released', artifact_revision_id = $3, release_wait_id = NULL, invalidation_reason = NULL, state_changed_at = $4::timestamptz, updated_by_work_order_id = $2, version = version + 1 WHERE run_unit_id = $1 AND output_name = $5", [row.run_unit_id, request.work_order_id, request.artifact_id, request.published_at, request.output_name]);
        const versions = await transaction.query<{ readonly record_version: string }>("UPDATE oakridge.workflow_run SET record_version = record_version + 1 WHERE id = $1 RETURNING record_version::text", [row.run_id]);
        const resultingVersion = Number(versions[0]?.record_version ?? 0) as RunRecordVersion;
        await insertTransition(transaction, { run_id: row.run_id as WorkflowRunId, run_unit_id: row.run_unit_id as RunUnitId, work_order_id: request.work_order_id, wait_id: null, output_name: request.output_name,
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
           (id, stage_instance_id, unit_id, kind, artifact_revision_id, closes_on, status, run_unit_id, output_name, execution_workflow_id, command_workflow_id, opened_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,'open',$7,$8,$9,$10,$11::timestamptz)`,
        [waitId, row.stage_instance_id, row.unit_id, waitKind, request.artifact_id, closesOn, row.run_unit_id, request.output_name, row.workflow_id,
          v2WaitCommandAddress(waitId), request.published_at],
      );
      await transaction.query("UPDATE oakridge.run_output_slot SET state = 'pending', artifact_revision_id = $3, release_wait_id = $6, invalidation_reason = NULL, state_changed_at = $4::timestamptz, updated_by_work_order_id = $2, version = version + 1 WHERE run_unit_id = $1 AND output_name = $5", [row.run_unit_id, request.work_order_id, request.artifact_id, request.published_at, request.output_name, waitId]);
      const versions = await transaction.query<{ readonly record_version: string }>("UPDATE oakridge.workflow_run SET record_version = record_version + 1 WHERE id = $1 RETURNING record_version::text", [row.run_id]);
      const resultingVersion = Number(versions[0]?.record_version ?? 0) as RunRecordVersion;
      await insertTransition(transaction, { run_id: row.run_id as WorkflowRunId, run_unit_id: row.run_unit_id as RunUnitId, work_order_id: request.work_order_id, wait_id: waitId, output_name: request.output_name,
        operation: "slot_pending", actor: `work_order:${request.work_order_id}`, prior_record_version: (resultingVersion - 1) as RunRecordVersion, resulting_record_version: resultingVersion, detail: { artifact_id: request.artifact_id, release_kind: release.kind }, created_at: request.published_at });
      return { kind: "pending", artifact_id: request.artifact_id, wait_id: waitId, run_id: row.run_id as WorkflowRunId, record_version: resultingVersion };
    });
  }

  async close_output_wait(request: CloseRunOutputWait): Promise<CloseRunOutputWaitResult> {
    return this.sql.transaction(async (transaction) => {
      const waitRows = await transaction.query<{ readonly status: "open" | "closed"; readonly kind: WaitClosesOn["kind"]; readonly outcome: WaitOutcome | null; readonly run_unit_id: string | null; readonly output_name: string | null; readonly run_id: string }>(
        `SELECT wait.status, wait.kind, wait.outcome, wait.run_unit_id::text, wait.output_name, unit.run_id::text
         FROM oakridge.wait wait JOIN oakridge.run_unit unit ON unit.id = wait.run_unit_id
         WHERE wait.id = $1 AND wait.run_unit_id IS NOT NULL FOR UPDATE OF wait`, [request.wait_id]);
      const wait = waitRows[0];
      if (!wait || !wait.run_unit_id || !wait.output_name) return { kind: "wait_not_found", detail: `v2 wait '${request.wait_id}' was not found` };
      const releaseOutcome: WaitOutcome = wait.kind === "handoff_external"
        ? { kind: "external_completed", correlation_id: request.detail ?? request.actor }
        : { kind: "decided", action: "release", decision_artifact_id: null, feedback: request.detail };
      const invalidateOutcome: WaitOutcome = wait.kind === "handoff_external"
        ? { kind: "withdrawn" }
        : { kind: "decided", action: "invalidate", decision_artifact_id: null, feedback: request.detail };
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
        "SELECT state AS slot_state, artifact_revision_id::text, updated_by_work_order_id::text FROM oakridge.run_output_slot WHERE run_unit_id = $1 AND output_name = $2 FOR UPDATE",
        [wait.run_unit_id, wait.output_name]);
      const slot = slotRows[0];
      if (!slot || slot.slot_state !== "pending" || !slot.artifact_revision_id) return { kind: "wait_conflict", detail: `output slot for wait '${request.wait_id}' is not pending` };
      await transaction.query("UPDATE oakridge.wait SET status = 'closed', outcome = $2::jsonb, closed_at = $3::timestamptz WHERE id = $1", [request.wait_id, requestedOutcome, request.decided_at]);
      if (request.disposition === "release") {
        await transaction.query("UPDATE oakridge.run_output_slot SET state = 'released', release_wait_id = NULL, invalidation_reason = NULL, state_changed_at = $3::timestamptz, version = version + 1 WHERE run_unit_id = $1 AND output_name = $2", [wait.run_unit_id, wait.output_name, request.decided_at]);
        await transaction.query("UPDATE oakridge.artifact SET lifecycle_state = 'released', released_at = $2::timestamptz, lifecycle_updated_at = $2::timestamptz WHERE id = $1 AND lifecycle_state = 'current'", [slot.artifact_revision_id, request.decided_at]);
      } else {
        const reason = { kind: "operator", detail: request.detail ?? "invalidated" };
        await transaction.query("UPDATE oakridge.run_output_slot SET state = 'invalidated', release_wait_id = NULL, invalidation_reason = $3::jsonb, state_changed_at = $4::timestamptz, version = version + 1 WHERE run_unit_id = $1 AND output_name = $2", [wait.run_unit_id, wait.output_name, reason, request.decided_at]);
        // The work order that produced the rejected artifact has nothing left
        // to do — its business work is over, not merely paused. Leaving it
        // `started` would make `selectUnitDecision` read the unit as
        // perpetually `work_in_progress` for a workflow that already returned.
        // A new work order (Slice 5's operator retry) is a separate decision.
        if (slot.updated_by_work_order_id) {
          await transaction.query("UPDATE oakridge.work_order SET state = 'abandoned', completed_at = $2::timestamptz WHERE id = $1 AND state IN ('available','started')", [slot.updated_by_work_order_id, request.decided_at]);
        }
      }
      const versions = await transaction.query<{ readonly record_version: string }>("UPDATE oakridge.workflow_run SET record_version = record_version + 1 WHERE id = $1 RETURNING record_version::text", [wait.run_id]);
      const resultingVersion = Number(versions[0]?.record_version ?? 0) as RunRecordVersion;
      await insertTransition(transaction, { run_id: wait.run_id as WorkflowRunId, run_unit_id: wait.run_unit_id as RunUnitId, work_order_id: null, wait_id: request.wait_id, output_name: wait.output_name,
        operation: request.disposition === "release" ? "slot_released" : "slot_invalidated", actor: request.actor,
        prior_record_version: (resultingVersion - 1) as RunRecordVersion, resulting_record_version: resultingVersion, detail: { via: "wait_close" }, created_at: request.decided_at });
      return request.disposition === "release"
        ? { kind: "released", artifact_id: slot.artifact_revision_id as ArtifactId, run_id: wait.run_id as WorkflowRunId, record_version: resultingVersion }
        : { kind: "invalidated", run_id: wait.run_id as WorkflowRunId, record_version: resultingVersion };
    });
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
