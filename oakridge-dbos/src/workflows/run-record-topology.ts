import { DBOS } from "@dbos-inc/dbos-sdk";

import type { AskResult } from "../decision/commands";
import { executorHealthFromTerminal, type WorkOrderExecution } from "../domain/run-record";
import { executorOperationIdForWorkOrder, type WorkflowRunId, type WorkOrderId } from "../domain/primitives";
import type { ExecutorAdapter, ExecutorObservationAttempt, ExternalExecutionReference } from "../domain/execution";
import type { Result } from "../domain/primitives";
import type { StageOutcome } from "../domain/workflow";
import type { RunRecordRepository, RunRecordRepositoryError } from "../storage/repositories";

export interface RunRecordWorkflowServices {
  readonly records: RunRecordRepository;
  find_executor(executor_type: string): ExecutorAdapter | undefined;
  now(): string;
}

let services: RunRecordWorkflowServices | null = null;
export const registerRunRecordWorkflowServices = (value: RunRecordWorkflowServices): void => { services = value; };
const workflowServices = (): RunRecordWorkflowServices => {
  if (!services) throw new Error("run-record workflow services are not registered");
  return services;
};

const decideRunStep = DBOS.registerStep(
  async (run_id: WorkflowRunId): Promise<Result<AskResult, RunRecordRepositoryError>> => workflowServices().records.decide_run(run_id, workflowServices().now()),
  { name: "oakridgeV2DecideRunStep", retriesAllowed: true, maxAttempts: 5, intervalSeconds: 1, backoffRate: 2 },
);

const loadWorkOrderStep = DBOS.registerStep(
  async (work_order_id: WorkOrderId): Promise<WorkOrderExecution> => {
    const execution = await workflowServices().records.find_work_order_execution(work_order_id);
    if (!execution) throw new Error(`work order '${work_order_id}' was not found`);
    return execution;
  },
  { name: "oakridgeV2LoadWorkOrderStep", retriesAllowed: true },
);

const ensureExecutorStep = DBOS.registerStep(
  async (execution: WorkOrderExecution): Promise<ExternalExecutionReference> => {
    const { records } = workflowServices();
    const adapter = workflowServices().find_executor(execution.request.executor_type);
    if (!adapter) throw new Error(`executor adapter '${execution.request.executor_type}' is not registered`);
    await records.ensure_executor_attachment(execution.work_order.id, execution.request.executor_type, workflowServices().now());
    const reference = await adapter.start_or_attach(execution.request, executorOperationIdForWorkOrder(execution.work_order.id));
    await records.attach_external(execution.work_order.id, reference, workflowServices().now());
    return reference;
  },
  { name: "oakridgeV2EnsureExecutorStep", retriesAllowed: true },
);

interface ObserveWorkOrderInput { readonly execution: WorkOrderExecution; readonly reference: ExternalExecutionReference }
const observeExecutorStep = DBOS.registerStep(
  async (input: ObserveWorkOrderInput): Promise<ExecutorObservationAttempt> => {
    const adapter = workflowServices().find_executor(input.execution.request.executor_type);
    if (!adapter) throw new Error(`executor adapter '${input.execution.request.executor_type}' is not registered`);
    const observation = await adapter.observe_terminal(input.execution.request.execution_id, input.reference);
    const now = workflowServices().now();
    if (observation.kind === "terminal") await workflowServices().records.observe_executor(input.execution.work_order.id, executorHealthFromTerminal(observation.observation, now), now);
    else await workflowServices().records.observe_executor(input.execution.work_order.id, { kind: "running", observed_at: now }, now);
    return observation;
  },
  { name: "oakridgeV2ObserveExecutorStep", retriesAllowed: true },
);

interface CleanupWorkOrderInput { readonly execution: WorkOrderExecution; readonly reference: ExternalExecutionReference }
const cleanupExecutorStep = DBOS.registerStep(
  async (input: CleanupWorkOrderInput): Promise<void> => {
    const adapter = workflowServices().find_executor(input.execution.request.executor_type);
    if (!adapter) throw new Error(`executor adapter '${input.execution.request.executor_type}' is not registered`);
    const now = workflowServices().now();
    await workflowServices().records.request_cleanup(input.execution.work_order.id, now);
    try {
      await adapter.cancel_or_fence(input.execution.request.execution_id, input.reference);
      await workflowServices().records.finish_cleanup(input.execution.work_order.id, true, workflowServices().now());
    } catch (error) {
      await workflowServices().records.finish_cleanup(input.execution.work_order.id, false, workflowServices().now());
      throw error;
    }
  },
  { name: "oakridgeV2CleanupExecutorStep", retriesAllowed: true },
);

export const runRecordCleanupWorkflow = DBOS.registerWorkflow(async (input: CleanupWorkOrderInput): Promise<void> => {
  await cleanupExecutorStep(input);
}, { name: "oakridgeV2CleanupExecutorWorkflow" });

const OBSERVE_INTERVAL_SECONDS = 5;

/** Independent child: its return value is never a domain outcome. */
export const runRecordWorkOrderWorkflow = DBOS.registerWorkflow(async (work_order_id: WorkOrderId): Promise<void> => {
  const execution = await loadWorkOrderStep(work_order_id);
  const reference = await ensureExecutorStep(execution);
  for (;;) {
    const observation = await observeExecutorStep({ execution, reference });
    if (observation.kind === "terminal") {
      await DBOS.startWorkflow(runRecordCleanupWorkflow, { workflowID: `${execution.work_order.workflow_id}:cleanup` })({ execution, reference });
      return;
    }
    await DBOS.sleepSeconds(OBSERVE_INTERVAL_SECONDS);
  }
}, { name: "oakridgeV2WorkOrderWorkflow" });

export interface RunRecordWorkflowResult { readonly run_id: WorkflowRunId; readonly outcome: StageOutcome }

/**
 * Every commit that can change `decide_run`'s answer for this run — a
 * publication, a wait close, the run's own state transitions — sends one of
 * these to wake the root sooner than the bounded timeout. The topic carries
 * no payload the workflow trusts: a lost, duplicated, or out-of-order
 * delivery only ever means "ask again", and asking again is always safe.
 */
export const RUN_RECORD_WAKE_TOPIC = "oakridge-v2-run-record-wake";
/** The bound on how long a lost or never-sent wake can delay a recheck. */
export const RUN_RECORD_WAKE_TIMEOUT_SECONDS = 5;
/** How long the root sleeps, durably, before asking again after a run of failed asks. */
export const RUN_RECORD_ASK_FAILURE_BACKOFF_SECONDS = 30;

/**
 * A bounded recheck makes notifications an optimization rather than
 * correctness: `DBOS.recv` either returns a wake hint or times out, and
 * either way the very next line re-reads the authoritative record. No
 * decision here is ever taken from the hint's payload or its absence.
 *
 * The only step is `decideRunStep`. Anything it throws (a blip that outlasts
 * the step's own `maxAttempts`) is caught here, logged, and slept through
 * durably: the run stays `active` and visible, and the root asks again once
 * the cause clears — no wake, no operator action (spec §3.5). `run_not_found`
 * is the one case that still ends the workflow by throwing: the record was
 * deleted and there is nothing left to keep alive.
 */
export const runRecordWorkflow = DBOS.registerWorkflow(async (run_id: WorkflowRunId): Promise<RunRecordWorkflowResult> => {
  for (;;) {
    let ask: Result<AskResult, RunRecordRepositoryError>;
    try {
      ask = await decideRunStep(run_id);
    } catch (error) {
      DBOS.logger.error(`run ${run_id}: ask failed, retrying in ${RUN_RECORD_ASK_FAILURE_BACKOFF_SECONDS}s: ${String(error)}`);
      await DBOS.sleepSeconds(RUN_RECORD_ASK_FAILURE_BACKOFF_SECONDS);
      continue;
    }
    if (!ask.ok) throw new Error(`${ask.error.operation}:${ask.error.kind}:${ask.error.detail}`);
    if (ask.value.kind === "complete") return { run_id, outcome: ask.value.outcome };
    if (ask.value.kind === "recheck") {
      for (const order of ask.value.started) {
        const execution = await loadWorkOrderStep(order.id);
        await DBOS.startWorkflow(runRecordWorkOrderWorkflow, { workflowID: execution.work_order.workflow_id })(execution.work_order.id);
      }
      continue; // something changed: ask again now, no recv
    }
    await DBOS.recv(RUN_RECORD_WAKE_TOPIC, { timeoutSeconds: RUN_RECORD_WAKE_TIMEOUT_SECONDS });
  }
}, { name: "oakridgeV2RunWorkflow" });
