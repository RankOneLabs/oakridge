import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createProductionComposition } from "../src/runtime/compose";
import { DEFAULT_WORKFLOW_TIMING, childWorkflowId, dispatchChild, intentWorkflowId, registerWorkflowServices, wakeRun } from "../src/workflows/topology";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { sealEffectPayload } from "../src/storage/effect-secret";
import type { EffectPayload } from "../src/effects/intents";
import { begin, sessionBundle, withDatabase } from "./effect-fixture";

const topology = readFileSync(resolve(import.meta.dir, "../src/workflows/topology.ts"), "utf8");
const completedChild = DBOS.registerWorkflow(async (): Promise<null> => null, { name: "oakridgeTestCompletedChild" });

test("run bodies keep child dispatch and scope lookup in durable DBOS operations", () => {
  expect(topology).not.toContain("const started = new Set");
  const wake_body = topology.split("async function wakeRunOf(")[1]?.split("const runOfScopeStep")[0];
  expect(wake_body).toBeDefined();
  expect(wake_body).not.toContain(".db.query");
  const run_body = topology.split("export async function dispatchChild(")[1]?.split("// ------------------------------------------------------------- entry")[0];
  expect(run_body).toBeDefined();
  expect(run_body).not.toContain(".db.query");
});

// The deadline stamp is a registered step, so dispatching a "start" child
// now requires a launched DBOS runtime (ensureDBOSIsLaunched fires inside
// DBOS.registerStep's wrapper regardless of workflow context).
test("a PENDING child is not dispatched again, while a missing child is started", async () => withDatabase(async ({ url }) => {
  const db = { query: async (sql: string) => {
    if (sql.includes("SELECT * FROM authority.effect_intent WHERE id=$1")) return [{ id: "intent-1", run_id: "run-1", scope_id: "scope-1",
      execution_id: null, effect_key: "key", status: "pending", dispatch_generation: 0, redispatch_failures: 0, deadline_epoch_ms: null,
      version: 0, payload: sealEffectPayload({ action: "start", handle: null,
        invocation: { id: "intent-1", execution_id: "execution-1", selection: {}, bytes: "pinned" } } as unknown as EffectPayload) }];
    if (sql.includes("SET deadline_epoch_ms=COALESCE")) return [{ deadline_epoch_ms: Date.now() + DEFAULT_WORKFLOW_TIMING.execution_deadline_ms }];
    return [];
  } } as unknown as TransactionalSqlExecutor;
  registerWorkflowServices({ db, timing: DEFAULT_WORKFLOW_TIMING } as Parameters<typeof registerWorkflowServices>[0]);
  DBOS.setConfig({ name: "oakridge", systemDatabaseUrl: url, applicationVersion: "test-dispatch" });
  await DBOS.launch();
  const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: "PENDING" }) as never);
  const calls: unknown[][] = [];
  const start = spyOn(DBOS, "startWorkflow").mockImplementation(((_workflow: unknown, options: unknown) => {
    calls.push([options]);
    return async (...args: unknown[]) => { calls.push(args); return {} as never; };
  }) as never);
  try {
    await dispatchChild("run-1", "intent-1", "start");
    expect(calls).toEqual([]);
    status.mockImplementation(async () => null as never);
    await dispatchChild("run-1", "intent-1", "start");
    expect(calls).toEqual([[{ workflowID: intentWorkflowId("intent-1"), timeoutMS: expect.any(Number) }], ["intent-1"]]);
    const dispatched_timeout_ms = (calls[0]?.[0] as { timeoutMS: number }).timeoutMS;
    expect(Math.abs(dispatched_timeout_ms - DEFAULT_WORKFLOW_TIMING.execution_deadline_ms)).toBeLessThan(5_000);
  } finally { status.mockRestore(); start.mockRestore(); await DBOS.shutdown(); }
}), 25_000);

test("restart preserves an already-started effect and dispatches a pending one", async () => withDatabase(async ({ url, db }) => {
  let starts = 0;
  const provider = {
    start: async () => { starts++; return { kind: "acknowledged" as const, value: { kind: "kbbl_session" as const, session_id: `session-${starts}` } }; },
    observe: async () => ({ kind: "acknowledged" as const, value: { kind: "running" as const } }),
    stop: async () => ({ kind: "acknowledged" as const, value: { stopped: true as const } }),
  };
  const options = { database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"),
    host: "127.0.0.1", effect_provider: provider, timing: { observe_interval_seconds: 0.05, wake_timeout_seconds: 0.05 } };
  let composition = await createProductionComposition(options);
  try {
    const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: "wait",
      workdir: "/tmp", session_name: "durable", session_identity: {}, worktree: { branchName: "selected", worktreeSubdir: "selected" } });
    const first = async () => (await db.query<{ id: string; status: string; payload: object }>(
      "SELECT id,status,payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start' ORDER BY id LIMIT 1", [run.root_scope_id]))[0];
    const until = Date.now() + 10_000;
    while ((await first())?.status !== "acknowledged" && Date.now() < until) await Bun.sleep(25);
    expect((await first())?.status).toBe("acknowledged");
    expect(starts).toBe(1);
    await composition.close();

    const original = await first();
    if (!original) throw new Error("first effect missing");
    const second_id = crypto.randomUUID();
    const payload = original.payload as { readonly invocation: { readonly id: string } };
    const pending = { ...payload, invocation: { ...payload.invocation, id: second_id }, action: "start", handle: null,
      start_attempts: 0, start_in_flight: false, has_dispatched: false, has_uncertain_start: false };
    await db.query(`INSERT INTO authority.effect_intent (id,run_id,scope_id,effect_key,payload,status)
      VALUES ($1,$2,$3,$4,$5,'pending')`, [second_id, run.run_id, run.root_scope_id, "second-pending", JSON.stringify(pending)]);

    composition = await createProductionComposition(options);
    await wakeRun(run.run_id);
    const after = Date.now() + 10_000;
    while (Date.now() < after) {
      const row = (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE id=$1", [second_id]))[0];
      if (row?.status === "acknowledged") break;
      await Bun.sleep(25);
    }
    expect((await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE id=$1", [second_id]))[0]?.status).toBe("acknowledged");
    expect(starts).toBe(2);
    expect((await first())?.status).toBe("acknowledged");
  } finally { await composition.close(); }
}), 25_000);

test("a terminal child with its intent still owed is redispatched under a new generation, never stranding the run as ERROR", async () => withDatabase(async ({ url, db }) => {
  let starts = 0;
  const provider = {
    start: async () => { starts++; return { kind: "acknowledged" as const, value: { kind: "kbbl_session" as const, session_id: `session-${starts}` } }; },
    observe: async () => ({ kind: "acknowledged" as const, value: { kind: "running" as const } }),
    stop: async () => ({ kind: "acknowledged" as const, value: { stopped: true as const } }),
  };
  const composition = await createProductionComposition({ database_url: url,
    core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    effect_provider: provider, timing: { observe_interval_seconds: 0.05, wake_timeout_seconds: 0.05 } });
  try {
    const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: "wait",
      workdir: "/tmp", session_name: "redispatch", session_identity: {}, worktree: { branchName: "selected", worktreeSubdir: "selected" } });
    const first = async () => (await db.query<{ id: string; status: string; payload: { readonly invocation: { readonly id: string } } }>(
      "SELECT id,status,payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start' ORDER BY id LIMIT 1", [run.root_scope_id]))[0];
    const until = Date.now() + 10_000;
    while ((await first())?.status !== "acknowledged" && Date.now() < until) await Bun.sleep(25);
    const original = await first();
    if (!original) throw new Error("first effect missing");

    const intent_id = crypto.randomUUID();
    const pending = { ...original.payload, invocation: { ...original.payload.invocation, id: intent_id }, action: "start", handle: null,
      start_attempts: 0, start_in_flight: false, has_dispatched: false, has_uncertain_start: false };
    // A carrier that ended SUCCESS while its intent is still pending: dispatchChild
    // must redispatch it under the next dispatch generation rather than throwing.
    await (await DBOS.startWorkflow(completedChild, { workflowID: intentWorkflowId(intent_id) })()).getResult();
    await db.query(`INSERT INTO authority.effect_intent (id,run_id,scope_id,effect_key,payload,status)
      VALUES ($1,$2,$3,$4,$5,'pending')`, [intent_id, run.run_id, run.root_scope_id, "redispatched-child", JSON.stringify(pending)]);
    await wakeRun(run.run_id);
    const after = Date.now() + 10_000;
    while (Date.now() < after) {
      const status = await DBOS.getWorkflowStatus(`run:${run.run_id}`);
      expect(status?.status).not.toBe("ERROR");
      const row = (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE id=$1", [intent_id]))[0];
      if (row?.status === "acknowledged") break;
      await Bun.sleep(25);
    }
    expect((await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE id=$1", [intent_id]))[0]?.status).toBe("acknowledged");
    expect(await DBOS.getWorkflowStatus(childWorkflowId(intent_id, 1))).not.toBeNull();
    expect((await DBOS.getWorkflowStatus(`run:${run.run_id}`))?.status).not.toBe("ERROR");
  } finally { await composition.close(); }
}), 25_000);
