/**
 * A standalone process — not a `bun:test` file — that launches DBOS against
 * the run-record workflows, and then hangs forever.
 *
 * `run-record-process-crash.test.ts` spawns one of these to *start* a
 * workflow, waits for the durable boundary it wants to test, and sends it
 * SIGKILL. A killed process cannot gracefully drain: it is dead
 * mid-execution, which is exactly what an in-process `DBOS.shutdown()`
 * cannot simulate (it drains every registered workflow to its own natural
 * stopping point, so a work-order workflow built to keep observing until its
 * executor reports terminal never lets it return). It then spawns a *second*
 * instance of this same script in `recover` action to bring DBOS back up
 * against the same database and application version, which is the only
 * thing that triggers DBOS's real recovery scan. Neither phase runs inside
 * the test process itself: `DBOS` is a process-wide singleton, and a
 * `DBOS.shutdown()` that does not return cleanly after a recovery — observed
 * empirically while building this harness — would otherwise wedge every
 * later test in the same `bun test` run.
 *
 * Configuration arrives entirely through environment variables so the parent
 * needs no IPC beyond polling Postgres for the state it is waiting on, and
 * (for `start_or_attach` call visibility during recovery) reading one marker
 * line from this process's stdout.
 */
import { randomUUID } from "node:crypto";

import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ExecutionRequest, ExecutorAdapter, ExecutorObservationAttempt, ExternalExecutionReference } from "../../src/domain/execution";
import type { WorkOrderId, WorkflowRunId } from "../../src/domain/primitives";
import { PostgresRunRecordRepository } from "../../src/storage/postgres-run-record";
import { PgPostgresExecutor } from "../../src/storage/sql-executor";
import { registerRunRecordWorkflowServices, runRecordWorkflow, runRecordWorkOrderWorkflow } from "../../src/workflows/run-record-topology";
import { READY_MARKER, START_OR_ATTACH_CALLED_MARKER } from "./run-record-crash-worker-protocol";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const databaseUrl = env("CRASH_WORKER_DATABASE_URL");
const applicationVersion = env("CRASH_WORKER_APPLICATION_VERSION");
/** `start`: launch and start a fresh workflow, then hang until killed. `recover`: launch only — DBOS's own recovery scan resumes whatever this application version left PENDING. */
const action = env("CRASH_WORKER_ACTION") as "start" | "recover";
const executorType = env("CRASH_WORKER_EXECUTOR_TYPE");
/** Only `recover` needs the work order to actually finish quickly; `start` must never report terminal on its own — the parent commits that fact out of band. */
const reportsTerminal = action === "recover";

const sql = PgPostgresExecutor.connect(databaseUrl);
const records = new PostgresRunRecordRepository(sql);

const adapter: ExecutorAdapter = {
  executor_type: executorType,
  async start_or_attach(_request: ExecutionRequest, _operation_id): Promise<ExternalExecutionReference> {
    // A marker line, not a return value: the parent reads this process's
    // stdout to know whether recovery re-ran this step, since the parent and
    // this worker do not share JS memory to hold a call counter in.
    console.log(START_OR_ATTACH_CALLED_MARKER);
    return { kind: "kbbl_session", session_id: `crash-worker-${randomUUID()}` };
  },
  async observe_terminal(): Promise<ExecutorObservationAttempt> {
    if (reportsTerminal) return { kind: "terminal", observation: { kind: "succeeded", metadata: {} } };
    return { kind: "pending" };
  },
  async deliver_input() {},
  async cancel_or_fence() {},
};

DBOS.setConfig({ name: "oakridge-run-record-crash-worker", systemDatabaseUrl: databaseUrl, applicationVersion, logLevel: "warn" });
registerRunRecordWorkflowServices({ records, find_executor: () => adapter, now: () => new Date().toISOString() });
await DBOS.launch();

if (action === "start") {
  const mode = env("CRASH_WORKER_MODE") as "root" | "work_order";
  if (mode === "root") {
    const runId = env("CRASH_WORKER_RUN_ID") as WorkflowRunId;
    await DBOS.startWorkflow(runRecordWorkflow, { workflowID: runId })(runId);
  } else {
    const workOrderId = env("CRASH_WORKER_WORK_ORDER_ID") as WorkOrderId;
    const workOrderWorkflowId = env("CRASH_WORKER_WORK_ORDER_WORKFLOW_ID");
    await DBOS.startWorkflow(runRecordWorkOrderWorkflow, { workflowID: workOrderWorkflowId })(workOrderId);
  }
}
// `action === "recover"` starts nothing: DBOS's own launch-time recovery scan
// finds and resumes whatever this application version left PENDING.

console.log(READY_MARKER);
// Held open on purpose: DBOS's workflow executor keeps running in the
// background on this same event loop. The process now waits only to be
// killed by its parent.
await new Promise(() => {});
