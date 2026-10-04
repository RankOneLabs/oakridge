/**
 * One durable workflow per run, stage and selected worker execution.
 * The run decides stage lifecycle; each stage freezes membership and rechecks
 * its cohorts through the shared versioned ingress. Worker workflows perform
 * selected IO with a stable execution identity and observe session health.
 *
 * Wake messages are hints. Every bounded recheck reads authoritative records;
 * missed or repeated hints cannot select a decision or repeat an execution.
 */
import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import type { StageEventApplier } from "../storage/apply-stage-event";

import { runMachineWorkflowId, stageMachineWorkflowId } from "../decision/ids";
import { type RunDecision, type RunRecordRepositoryError, type TransitionEffectDescriptor } from "../domain/run-record";
import type { CohortId, Result, StageInstanceId, WorkflowRunId } from "../domain/primitives";
import type { ExecutionId } from "../domain/primitives";
import type { TransitionOwner } from "../domain/run-record";
import type { RunRecordRepository } from "../storage/repositories";
import { MACHINE_WAKE_TOPIC, sendRunWakeHint } from "../http/dbos-transport";
import { materializeStageInStorage } from "../storage/materialize-stage";

export interface DecisionMachineAddress {
  readonly owner: TransitionOwner;
  readonly workflow_id: string;
}

export const runMachineAddress = (run_id: WorkflowRunId): DecisionMachineAddress => ({
  owner: { kind: "run", id: run_id },
  workflow_id: runMachineWorkflowId(run_id),
});

export const stageMachineAddress = (stage_instance_id: StageInstanceId): DecisionMachineAddress => ({
  owner: { kind: "stage_instance", id: stage_instance_id },
  workflow_id: stageMachineWorkflowId(stage_instance_id),
});

/** The bound on how long a lost or never-sent wake can delay a recheck. */
export const MACHINE_WAKE_TIMEOUT_SECONDS = 60;
/** How long a machine sleeps, durably, after a run of failed asks. */
export const MACHINE_FAILURE_BACKOFF_SECONDS = 30;
const OBSERVE_INTERVAL_SECONDS = 5;

export interface RunRecordWorkflowServices {
  readonly records: RunRecordRepository;
  readonly effects_sql?: TransactionalSqlExecutor;
  readonly stage_events?: StageEventApplier;
  initialize_run?(run_id: WorkflowRunId): Promise<void>;
  dispatch_worker_execution?(execution_id: ExecutionId): Promise<void>;
  observe_worker_execution?(execution_id: ExecutionId): Promise<import("../runtime/observe-worker-execution").WorkerObservation>;
  now(): string;
}

let services: RunRecordWorkflowServices | null = null;
export const registerRunRecordWorkflowServices = (value: RunRecordWorkflowServices): void => { services = value; };
const workflowServices = (): RunRecordWorkflowServices => {
  if (!services) throw new Error("run-record workflow services are not registered");
  return services;
};

/* ------------------------------------------------------------------ *
 * The run machine
 * ------------------------------------------------------------------ */

const initializeRunStep = DBOS.registerStep(async (run_id: WorkflowRunId): Promise<void> => {
  await workflowServices().initialize_run?.(run_id);
}, { name: "oakridgeV15InitializeRunStep", retriesAllowed: true });

const decideRunStep = DBOS.registerStep(
  async (run_id: WorkflowRunId): Promise<Result<RunDecision, RunRecordRepositoryError>> => {
    const decided = await workflowServices().records.decide_run(run_id, workflowServices().now());
    // Missing runs are a durable outcome: DBOS wraps exhausted step errors and
    // deserializes replayed errors, so exception identity cannot carry this fact.
    if (!decided.ok && decided.error.kind !== "run_not_found") {
      throw new Error(`${decided.error.operation}:${decided.error.kind}:${decided.error.detail}`);
    }
    return decided;
  },
  { name: "oakridgeV15DecideRunStep", retriesAllowed: true, maxAttempts: 5, intervalSeconds: 1, backoffRate: 2 },
);

const isTerminal = (status: RunDecision["status"]): boolean =>
  status === "complete" || status === "failed" || status === "cancelled";

/** The stage instance a `start_stage` effect names, or null for any other effect. */
const startedStageOf = (effect: TransitionEffectDescriptor): StageInstanceId | null =>
  effect.kind === "start_stage" && typeof effect.stage_instance_id === "string"
    ? effect.stage_instance_id as StageInstanceId
    : null;

export interface RunMachineResult { readonly run_id: WorkflowRunId; readonly status: RunDecision["status"]; readonly outcome: RunDecision["outcome"] }

/**
 * The registered name of a run's root machine.
 *
 * Exported so the launch client enqueues by the same name the workflow is
 * registered under. Spelling it twice is how a launch came to enqueue a
 * workflow nothing served: DBOS records the row, the run reads as PENDING and
 * therefore alive, and no executor ever picks it up.
 */
export const RUN_MACHINE_WORKFLOW_NAME = "oakridgeV15RunWorkflow";

/**
 * The run's root workflow.
 *
 * Its only step is `decideRunStep`. Anything that step throws — a blip
 * outlasting its own `maxAttempts` — is caught, logged, and slept through
 * durably: the run stays visible in whatever state it is in, and the machine
 * asks again once the cause clears. A deleted run is the one case that ends the
 * workflow, because there is no longer a record to keep alive.
 */
export const runMachineWorkflow = DBOS.registerWorkflow(async (run_id: WorkflowRunId): Promise<RunMachineResult | null> => {
  for (;;) {
    let decision: RunDecision;
    try {
      await initializeRunStep(run_id);
      const decided = await decideRunStep(run_id);
      if (!decided.ok) {
        if (decided.error.kind === "run_not_found") return null;
        throw new Error(`${decided.error.operation}:${decided.error.kind}:${decided.error.detail}`);
      }
      decision = decided.value;
    } catch (error) {
      if (error instanceof DBOSErrors.DBOSWorkflowCancelledError) return null;
      const message = String(error);
      DBOS.logger.error(`run ${run_id}: decide failed, retrying in ${MACHINE_FAILURE_BACKOFF_SECONDS}s: ${message}`);
      await DBOS.sleepSeconds(MACHINE_FAILURE_BACKOFF_SECONDS);
      continue;
    }
    for (const transition of decision.transitions) {
      const stage = startedStageOf(transition.effect);
      if (!stage) continue;
      // Addressed by the stage's own machine id, not the transition's effect id:
      // one stage has one machine, and a replayed dispatch must join it rather
      // than start a second.
      for (;;) {
        try {
          await DBOS.startWorkflow(stageMachineWorkflow, { workflowID: stageMachineWorkflowId(stage) })(stage);
          break;
        } catch (error) {
          if (error instanceof DBOSErrors.DBOSWorkflowCancelledError) return null;
          DBOS.logger.error(`run ${run_id}: stage dispatch failed, retrying: ${String(error)}`);
          await DBOS.sleepSeconds(MACHINE_FAILURE_BACKOFF_SECONDS);
        }
      }
    }
    if (isTerminal(decision.status)) return { run_id, status: decision.status, outcome: decision.outcome };
    if (decision.transitions.length > 0) continue; // something changed: ask again now, no recv
    await DBOS.recv(MACHINE_WAKE_TOPIC, { timeoutSeconds: MACHINE_WAKE_TIMEOUT_SECONDS });
  }
}, { name: RUN_MACHINE_WORKFLOW_NAME });

/* ------------------------------------------------------------------ *
 * The stage machine
 * ------------------------------------------------------------------ */

type StageRosterResult = { readonly kind: "opened"; readonly cohort_ids: readonly CohortId[] }
  | { readonly kind: "stage_not_active"; readonly detail: string }
  | { readonly kind: "roster_failed"; readonly detail: string };

const materializeStageStep = DBOS.registerStep(
  async (stage_instance_id: StageInstanceId): Promise<StageRosterResult> => {
    const { records, effects_sql, now } = workflowServices();
    if (!effects_sql) throw new Error("stage storage is not configured");
    const materialized = await materializeStageInStorage(effects_sql, { stage_instance_id, at: now() });
    if (materialized.ok) return materialized.value;
    const failed = await records.fail_stage_roster(stage_instance_id, materialized.error.detail, now());
    if (!failed.ok) throw new Error(`${failed.error.operation}:${failed.error.kind}:${failed.error.detail}`);
    return { kind: "roster_failed", detail: `${materialized.error.kind}: ${materialized.error.detail}` };

  },
  { name: "oakridgeV15MaterializeStageStep", retriesAllowed: true },
);

const advanceStageCohortsStep = DBOS.registerStep(async (stage_instance_id: StageInstanceId): Promise<boolean> => {
  const { effects_sql, stage_events } = workflowServices();
  if (!effects_sql || !stage_events) throw new Error("stage progression is not configured");
  const rows = await effects_sql.query<{ readonly id: CohortId; readonly state: string }>(
    "SELECT id::text,state FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY materialization_position,cohort_key", [stage_instance_id]);
  for (const row of rows) {
    if (["complete", "failed", "cancelled"].includes(row.state)) continue;
    const advanced = await stage_events.advance(row.id, null);
    if (!advanced.ok && advanced.error.kind !== "capacity_full" && advanced.error.kind !== "owner_stopped")
      throw new Error(`cohort ${row.id}: ${advanced.error.kind}:${"detail" in advanced.error ? advanced.error.detail : ""}`);
  }
  const state = await effects_sql.query<{ readonly run_id: WorkflowRunId; readonly status: string; readonly version: string; readonly cohorts_version: string }>(
    `SELECT run_id::text,status,durable_version::text AS version,
      COALESCE((SELECT string_agg(durable_version::text,',' ORDER BY materialization_position,cohort_key)
        FROM oakridge.cohort WHERE stage_instance_id=$1),'') AS cohorts_version
     FROM oakridge.stage_instance WHERE id=$1`, [stage_instance_id]);
  if (state[0]) await sendRunWakeHint(state[0].run_id, `stage-recheck:${stage_instance_id}:${state[0].version}:${state[0].cohorts_version}`);
  return !state[0] || ["complete", "failed", "cancelled"].includes(state[0].status);
}, { name: "oakridgeV15AdvanceStageCohortsStep", retriesAllowed: true });

/** Freezes stage membership, then advances its cohorts until the run closes the stage. */
export const stageMachineWorkflow = DBOS.registerWorkflow(async (stage_instance_id: StageInstanceId): Promise<StageRosterResult | null> => {
  for (;;) {
    let result: StageRosterResult;
    try {
      result = await materializeStageStep(stage_instance_id);
    } catch (error) {
      if (error instanceof DBOSErrors.DBOSWorkflowCancelledError) return null;
      DBOS.logger.error(`stage ${stage_instance_id}: roster failed, retrying in ${MACHINE_FAILURE_BACKOFF_SECONDS}s: ${String(error)}`);
      await DBOS.sleepSeconds(MACHINE_FAILURE_BACKOFF_SECONDS);
      continue;
    }
    if (result.kind !== "opened") return result;
    try {
      if (await advanceStageCohortsStep(stage_instance_id)) return result;
    } catch (error) {
      if (error instanceof DBOSErrors.DBOSWorkflowCancelledError) return null;
      DBOS.logger.error(`stage ${stage_instance_id}: recheck failed: ${String(error)}`);
      await DBOS.sleepSeconds(MACHINE_FAILURE_BACKOFF_SECONDS);
      continue;
    }
    await DBOS.recv(MACHINE_WAKE_TOPIC, { timeoutSeconds: OBSERVE_INTERVAL_SECONDS });
  }
}, { name: "oakridgeV15StageWorkflow" });

/** One recoverable workflow per selected worker execution, with stable IO identity. */
const dispatchWorkerExecutionStep = DBOS.registerStep(async (execution_id: ExecutionId): Promise<void> => {
  const dispatch = workflowServices().dispatch_worker_execution;
  if (!dispatch) throw new Error("worker execution dispatch is not configured");
  await dispatch(execution_id);
}, { name: "oakridgeV15DispatchWorkerExecutionStep", retriesAllowed: true });
const observeWorkerExecutionStep = DBOS.registerStep(async (execution_id: ExecutionId): Promise<import("../runtime/observe-worker-execution").WorkerObservation> => {
  return await workflowServices().observe_worker_execution?.(execution_id) ?? { kind: "terminal" };
}, { name: "oakridgeV15ObserveWorkerExecutionStep", retriesAllowed: true });
export const WORKER_EXECUTION_WORKFLOW_NAME = "oakridgeV15WorkerExecutionWorkflow";
export const workerExecutionWorkflow = DBOS.registerWorkflow(async (execution_id: ExecutionId): Promise<void> => {
  let dispatched = false;
  for (;;) {
    try {
      if (!dispatched) { await dispatchWorkerExecutionStep(execution_id); dispatched = true; }
      if ((await observeWorkerExecutionStep(execution_id)).kind === "terminal") return;
    } catch (error) {
      if (error instanceof DBOSErrors.DBOSWorkflowCancelledError) return;
      DBOS.logger.error(`execution ${execution_id}: retrying after IO failure: ${String(error)}`);
    }
    await DBOS.sleepSeconds(OBSERVE_INTERVAL_SECONDS);
  }
}, { name: WORKER_EXECUTION_WORKFLOW_NAME });
