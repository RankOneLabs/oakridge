/**
 * A real OS-process kill/restart harness for `oakridgeV2RunWorkflow` and
 * `oakridgeV2WorkOrderWorkflow`.
 *
 * `run-record-crash-matrix.test.ts` proves every durable step's own effect is
 * idempotent under repository-level replay — the storage and external
 * idempotency cases the spec calls "covered now". What that file cannot
 * prove is DBOS's own recovery mechanics: that a step which already
 * checkpointed is *skipped*, not merely safe to repeat, when a process dies
 * mid-workflow and a fresh one recovers it. An in-process `DBOS.shutdown()`
 * cannot simulate that death either — it drains every registered workflow to
 * its own natural stopping point first, and `oakridgeV2WorkOrderWorkflow` is
 * built to keep observing until its executor reports terminal, so it never
 * reaches one on command.
 *
 * Both the crashing side and the recovering side run in real, separate OS
 * processes spawned from `run-record-crash-worker.ts` — never in this test
 * process. `DBOS` is a process-wide singleton, and empirically a
 * `DBOS.shutdown()` following a recovery does not reliably return; running
 * both phases as disposable child processes sidesteps that entirely and is
 * also a closer match to what a real restart is: a different process
 * altogether, quite possibly the same binary brought back up by a
 * supervisor.
 */
import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ArtifactId, InputFingerprint, RunUnitId, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import { applyMigrations } from "../src/storage/migrate";
import { PostgresRunRecordRepository } from "../src/storage/postgres-run-record";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { awaitCondition } from "./support/dev-flow-harness";
import { findTestDatabaseUrl } from "./support/durable-database";
import { READY_MARKER, START_OR_ATTACH_CALLED_MARKER } from "./support/run-record-crash-worker-protocol";

const databaseUrl = await findTestDatabaseUrl();
const sql = databaseUrl ? PgPostgresExecutor.connect(databaseUrl) : null;
if (sql) await applyMigrations(sql);
afterAll(async () => { await sql?.close(); });

const skip = (): void => console.warn("run-record process-crash test SKIPPED: no PostgreSQL reachable");

const WORKER_SCRIPT = resolve(import.meta.dir, "support/run-record-crash-worker.ts");

interface CrashUnit {
  readonly runId: WorkflowRunId;
  readonly workOrderId: WorkOrderId;
  readonly workOrderWorkflowId: string;
  readonly capabilityHash: string;
  readonly applicationVersion: string;
  readonly executorType: string;
}

/** One straight-through, immediate-release run, freshly initialized — not yet started by anyone. */
const seedUnit = async (label: string): Promise<CrashUnit | null> => {
  if (!sql) return null;
  const executorType = `crash-worker-${label}`;
  const definitionId = randomUUID() as WorkflowDefinitionId;
  const runId = randomUUID() as WorkflowRunId;
  const stageId = randomUUID() as StageInstanceId;
  const runUnitId = randomUUID() as RunUnitId;
  const workOrderId = randomUUID() as WorkOrderId;
  const workOrderWorkflowId = `v2-work:${workOrderId}`;
  const now = new Date().toISOString();
  const capabilityHash = createHash("sha256").update(`crash-${workOrderId}`).digest("hex");
  await sql.query(`INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at) VALUES ($1,$2,1,'{"graph":{"stages":{},"edges":[]}}'::jsonb,false,$3::timestamptz)`, [definitionId, `crash-worker-${runId}`, now]);
  await sql.query(`INSERT INTO oakridge.workflow_run (id, workflow_definition_id, context, created_at) VALUES ($1,$2,'{}'::jsonb,$3::timestamptz)`, [runId, definitionId, now]);
  const records = new PostgresRunRecordRepository(sql);
  await records.initialize_straight_through({
    run_id: runId, stage_instance_id: stageId, run_unit_id: runUnitId, unit_id: "unit-1" as UnitId,
    work_order_id: workOrderId, work_order_workflow_id: workOrderWorkflowId, stage_key: "build", executor_type: executorType,
    work_order_capability_hash: capabilityHash, resolved_config: {}, parameters: {}, input_snapshot: [], input_fingerprint: "empty" as InputFingerprint,
    outputs: [{ name: "result", artifact_type: "dev.result", required: true, release: { kind: "immediate" } }],
    created_at: now,
  });
  return { runId, workOrderId, workOrderWorkflowId, capabilityHash, executorType, applicationVersion: `crash-worker-${label}-${randomUUID()}` };
};

/** Reads a spawned process's stdout incrementally, without waiting for it to exit. */
const collectStdout = (stream: ReadableStream<Uint8Array> | null): { text(): string } => {
  let buffer = "";
  if (!stream) return { text: () => buffer };
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
    }
  })();
  return { text: () => buffer };
};

interface CrashWorker {
  readonly stdout: { text(): string };
  kill(): Promise<void>;
}

const spawnWorker = (env: Record<string, string>): CrashWorker => {
  const child = Bun.spawn(["bun", "run", WORKER_SCRIPT], {
    env: { ...process.env, ...env },
    stdout: "pipe", stderr: "inherit",
  });
  const stdout = collectStdout(child.stdout);
  let killed = false;
  return {
    stdout,
    async kill() {
      if (killed) return;
      killed = true;
      child.kill("SIGKILL");
      await child.exited;
    },
  };
};

const spawnStartWorker = (unit: CrashUnit, mode: "root" | "work_order"): CrashWorker =>
  spawnWorker({
    CRASH_WORKER_DATABASE_URL: databaseUrl!, CRASH_WORKER_APPLICATION_VERSION: unit.applicationVersion,
    CRASH_WORKER_ACTION: "start", CRASH_WORKER_MODE: mode, CRASH_WORKER_EXECUTOR_TYPE: unit.executorType,
    CRASH_WORKER_RUN_ID: unit.runId, CRASH_WORKER_WORK_ORDER_ID: unit.workOrderId, CRASH_WORKER_WORK_ORDER_WORKFLOW_ID: unit.workOrderWorkflowId,
  });

const spawnRecoveryWorker = (unit: CrashUnit): CrashWorker =>
  spawnWorker({
    CRASH_WORKER_DATABASE_URL: databaseUrl!, CRASH_WORKER_APPLICATION_VERSION: unit.applicationVersion,
    CRASH_WORKER_ACTION: "recover", CRASH_WORKER_EXECUTOR_TYPE: unit.executorType,
    // Unused by `recover`, but the worker's env reader still requires them present.
    CRASH_WORKER_MODE: "root", CRASH_WORKER_RUN_ID: unit.runId, CRASH_WORKER_WORK_ORDER_ID: unit.workOrderId, CRASH_WORKER_WORK_ORDER_WORKFLOW_ID: unit.workOrderWorkflowId,
  });

const executorAttached = (workOrderId: WorkOrderId) => async (): Promise<string | null> => {
  const rows = await sql!.query<{ readonly external_reference: { readonly session_id?: string } | null }>(
    "SELECT external_reference FROM oakridge.executor_attachment WHERE work_order_id = $1", [workOrderId]);
  return rows[0]?.external_reference?.session_id ?? null;
};

const workOrderStarted = (workOrderId: WorkOrderId) => async (): Promise<true | null> => {
  const rows = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.work_order WHERE id = $1", [workOrderId]);
  return rows[0]?.state === "started" ? true : null;
};

const cleanupComplete = (workOrderId: WorkOrderId) => async (): Promise<true | null> => {
  const rows = await sql!.query<{ readonly cleanup_state: string }>("SELECT cleanup_state FROM oakridge.executor_attachment WHERE work_order_id = $1", [workOrderId]);
  return rows[0]?.cleanup_state === "complete" ? true : null;
};

const runSucceeded = (runId: WorkflowRunId) => async (): Promise<true | null> => {
  const rows = await sql!.query<{ readonly state: string }>("SELECT state FROM oakridge.workflow_run WHERE id = $1", [runId]);
  return rows[0]?.state === "succeeded" ? true : null;
};

test("a work order killed right after its executor attaches recovers without a second external session", async () => {
  const unit = await seedUnit("attach");
  if (!unit) return skip();
  const worker = spawnStartWorker(unit, "work_order");
  try {
    await awaitCondition("the work order to attach its external session", executorAttached(unit.workOrderId), 10_000);
    const beforeKill = await executorAttached(unit.workOrderId)();
    await worker.kill();

    const recovery = spawnRecoveryWorker(unit);
    try {
      // ensureExecutorStep already checkpointed before the kill: recovery
      // must resume the workflow past it, not re-run its body.
      await awaitCondition("the recovered work order to reach cleanup", cleanupComplete(unit.workOrderId), 10_000);

      expect(recovery.stdout.text()).not.toContain(START_OR_ATTACH_CALLED_MARKER);
      const afterRecovery = await executorAttached(unit.workOrderId)();
      expect(afterRecovery).toBe(beforeKill);
      const attachments = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.executor_attachment WHERE work_order_id = $1", [unit.workOrderId]);
      expect(attachments[0]?.count).toBe("1");
    } finally {
      await recovery.kill();
    }
  } finally {
    await worker.kill();
  }
}, 30_000);

test("a root process killed right after starting its child recovers without a duplicate work order", async () => {
  const unit = await seedUnit("root-start");
  if (!unit) return skip();
  const worker = spawnStartWorker(unit, "root");
  try {
    // The window between the root's decide committing 'started' and the
    // child workflow actually beginning is exactly the boundary under test —
    // killing the instant the row is visible maximizes the chance of landing
    // inside it, and DBOS's per-step checkpointing makes the exact instant
    // immaterial to correctness either way.
    await awaitCondition("the work order to start", workOrderStarted(unit.workOrderId), 10_000);
    await worker.kill();

    const recovery = spawnRecoveryWorker(unit);
    try {
      await awaitCondition(`${READY_MARKER} from the recovery worker`, async () => (recovery.stdout.text().includes(READY_MARKER) ? true : null), 10_000);

      // The recovered root resumes its own ask loop; publishing out of band
      // (as an HTTP-driven agent would) is what lets it reach "complete".
      const records = new PostgresRunRecordRepository(sql!);
      const body = { done: true };
      const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      await awaitCondition("the recovered work order to be addressable", async () => {
        const result = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: unit.workOrderId, output_name: "result",
          body, capability_hash: unit.capabilityHash, idempotency_key: "root-start-result", payload_hash: payloadHash, published_at: new Date().toISOString() });
        return result.kind === "published" ? true : null;
      }, 10_000);

      await awaitCondition("the recovered run to succeed", runSucceeded(unit.runId), 10_000);

      const orders = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.work_order WHERE run_unit_id = (SELECT run_unit_id FROM oakridge.work_order WHERE id = $1)", [unit.workOrderId]);
      expect(orders[0]?.count).toBe("1");
    } finally {
      await recovery.kill();
    }
  } finally {
    await worker.kill();
  }
}, 30_000);

test("a process killed right after an artifact commits still completes the run on recovery, with no wake-up ever delivered", async () => {
  const unit = await seedUnit("post-commit");
  if (!unit) return skip();
  const worker = spawnStartWorker(unit, "root");
  try {
    await awaitCondition("the work order to attach its external session", executorAttached(unit.workOrderId), 10_000);

    // Committed by this parent process, out of band — the killed worker's
    // root never gets a chance to notice or wake up on it.
    const records = new PostgresRunRecordRepository(sql!);
    const body = { done: true };
    const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const published = await records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: unit.workOrderId, output_name: "result",
      body, capability_hash: unit.capabilityHash, idempotency_key: "post-commit-result", payload_hash: payloadHash, published_at: new Date().toISOString() });
    expect(published.kind).toBe("published");
    await worker.kill();

    const recovery = spawnRecoveryWorker(unit);
    try {
      // No wake was ever sent for this commit; only the recovered root's own
      // bounded recheck (see run-record-wake-hints.test.ts) can find it.
      await awaitCondition("the recovered run to succeed", runSucceeded(unit.runId), 10_000);

      const artifacts = await sql!.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.artifact WHERE work_order_id = $1", [unit.workOrderId]);
      expect(artifacts[0]?.count).toBe("1");
    } finally {
      await recovery.kill();
    }
  } finally {
    await worker.kill();
  }
}, 30_000);
