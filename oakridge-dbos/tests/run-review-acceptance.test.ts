import { expect, spyOn, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { withDatabase } from "./effect-fixture";
import { DEFAULT_WORKFLOW_TIMING, RUN_MAX_ITERATIONS, ensureRunWorkflow, registerWorkflowServices,
  dispatchChild, intentWorkflowId, runWorkflow, runWorkflowId, wakeRunOf } from "../src/workflows/topology";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { sealEffectPayload } from "../src/storage/effect-secret";
import type { EffectPayload } from "../src/effects/intents";

const forkTarget = DBOS.registerWorkflow(async (): Promise<string> => "done", { name: "oakridgeReviewForkTarget" });
const forkProbe = DBOS.registerWorkflow(async (target_id: string): Promise<void> => {
  await DBOS.listWorkflowSteps(target_id);
  await DBOS.forkWorkflow(target_id, 0, { newWorkflowID: `${target_id}:fork`, applicationVersion: DBOS.applicationVersion });
}, { name: "oakridgeReviewForkProbe" });

async function withDBOS(url: string, body: () => Promise<void>): Promise<void> {
  DBOS.setConfig({ name: "oakridge-review-test", systemDatabaseUrl: url, applicationVersion: "oakridge-review-test" });
  await DBOS.launch();
  try { await body(); } finally { await DBOS.shutdown(); }
}

test("the SDK checkpoints listWorkflowSteps and forkWorkflow in workflow bodies", async () => withDatabase(async ({ url }) => {
  await withDBOS(url, async () => {
    const target = await DBOS.startWorkflow(forkTarget, { workflowID: "review-target" })();
    await target.getResult();
    const probe = await DBOS.startWorkflow(forkProbe, { workflowID: "review-probe" })("review-target");
    await probe.getResult();
    const names = (await DBOS.listWorkflowSteps("review-probe"))?.map((step) => step.name) ?? [];
    expect(names).toContain("DBOS.listWorkflowSteps");
    expect(names).toContain("DBOS.forkWorkflow");
  });
}), 20_000);

test("ensureRunWorkflow and wakeRunOf fork ERROR generations from the failed step", async () => withDatabase(async ({ url }) => {
  await withDBOS(url, async () => {
    let generation = 0;
    const db = { query: async (sql: string) => {
      if (sql.includes("SELECT s.run_id,r.current_generation")) return [{ run_id: "run-1", current_generation: generation }];
      if (sql.includes("UPDATE authority.run SET current_generation")) return [{ current_generation: ++generation, current_cursor: null }];
      if (sql.includes("SELECT current_generation,current_cursor")) return [{ current_generation: generation, current_cursor: null }];
      throw new Error(`unexpected authority query: ${sql}`);
    } } as unknown as TransactionalSqlExecutor;
    registerWorkflowServices({ db, timing: DEFAULT_WORKFLOW_TIMING } as Parameters<typeof registerWorkflowServices>[0]);
    const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async (id) =>
      id === runWorkflowId("run-1", generation) ? ({ status: "ERROR" }) as never : null as never);
    const steps = spyOn(DBOS, "listWorkflowSteps").mockImplementation(async () => [
      { functionID: 2, error: null }, { functionID: 3, error: new Error("failed advance") },
    ] as never);
    const fork = spyOn(DBOS, "forkWorkflow").mockImplementation(async () => ({ workflowID: "forked" }) as never);
    const send = spyOn(DBOS, "send").mockImplementation(async () => undefined as never);
    try {
      await ensureRunWorkflow("run-1");
      expect(generation).toBe(1);
      expect(fork).toHaveBeenCalledWith(runWorkflowId("run-1"), 3,
        expect.objectContaining({ newWorkflowID: runWorkflowId("run-1", 1) }));
      await wakeRunOf("scope-1");
      expect(generation).toBe(2);
      expect(fork).toHaveBeenCalledWith(runWorkflowId("run-1", 1), 3,
        expect.objectContaining({ newWorkflowID: runWorkflowId("run-1", 2) }));
      expect(send).toHaveBeenCalledWith(runWorkflowId("run-1", 2), null, "oakridge-run-wake");
    } finally { status.mockRestore(); steps.mockRestore(); fork.mockRestore(); send.mockRestore(); }
  });
}), 30_000);

test("RUN_MAX_ITERATIONS hands pending dispatches and the scan cursor to the successor", async () => withDatabase(async ({ url }) => {
  await withDBOS(url, async () => {
    const scopes = Array.from({ length: RUN_MAX_ITERATIONS + 1 }, (_, index) => ({
      id: `scope-${String(index + 1).padStart(3, "0")}`, run_id: "run-1", scope_key: "none",
      parent_id: null, collection_key: null, child_key: null, is_terminal: false,
    }));
    let carried_cursor: string | null = null;
    let generation = 0;
    let child_started = false;
    const db = { query: async (sql: string, parameters: readonly unknown[]) => {
      if (sql.includes("SELECT r.id AS run_id,b.source")) return [{ run_id: "run-1", source: { scopes: [] } }];
      if (sql.includes("ORDER BY id LIMIT $3")) return scopes.filter((scope) => !parameters[1] || scope.id > String(parameters[1])).slice(0, Number(parameters[2]));
      if (sql.includes("SELECT * FROM authority.scope_instance WHERE id=ANY")) return [];
      if (sql.includes("SELECT e.id,e.status")) return child_started ? [] : [{ id: "pending-child", status: "pending" }];
      if (sql.includes("SELECT * FROM authority.effect_intent WHERE id=$1")) return [{ id: "pending-child", run_id: "run-1", scope_id: "scope-001",
        execution_id: null, effect_key: "key", payload: storedPayload("start"), status: "pending",
        dispatch_generation: 0, redispatch_failures: 0, deadline_epoch_ms: null, version: 0 }];
      if (sql.includes("SELECT is_terminal")) return [{ is_terminal: generation > 0 }];
      if (sql.includes("SELECT current_generation,current_cursor")) return [{ current_generation: generation, current_cursor: null }];
      if (sql.includes("UPDATE authority.run SET current_generation")) {
        carried_cursor = parameters[3] as string | null;
        return [{ current_generation: ++generation, current_cursor: carried_cursor }];
      }
      return [];
    } } as unknown as TransactionalSqlExecutor;
    registerWorkflowServices({ db, timing: { ...DEFAULT_WORKFLOW_TIMING, child_scan_max_scopes: 1, wake_timeout_seconds: 0.01 },
      core: {}, mutations: {} } as Parameters<typeof registerWorkflowServices>[0]);
    const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () =>
      generation === 0 ? ({ status: "PENDING" }) as never : null as never);
    const starts: { options: unknown; args: unknown[] }[] = [];
    let successor: { getResult(): Promise<unknown> } | null = null;
    const original_start = DBOS.startWorkflow.bind(DBOS);
    const start = spyOn(DBOS, "startWorkflow").mockImplementation(((workflow: unknown, options: { workflowID: string }) =>
      options.workflowID === runWorkflowId("run-1") ? original_start(workflow as typeof runWorkflow, options)
        : async (...args: unknown[]) => {
          starts.push({ options, args });
          if (options.workflowID === intentWorkflowId("pending-child")) { child_started = true; return {} as never; }
          successor = await original_start(workflow as typeof runWorkflow, options)(args[0] as string, args[1] as string | null);
          return successor as never;
        }) as never);
    try {
      await (await DBOS.startWorkflow(runWorkflow, { workflowID: runWorkflowId("run-1") })("run-1")).getResult();
      if (!successor) throw new Error("successor was not started");
      await (successor as { getResult(): Promise<unknown> }).getResult();
      expect(status).toHaveBeenCalledTimes(RUN_MAX_ITERATIONS + 1);
      expect(carried_cursor as string | null).toBe(`scope-${String(RUN_MAX_ITERATIONS).padStart(3, "0")}`);
      expect(starts).toEqual([
        { options: { workflowID: runWorkflowId("run-1", 1) }, args: ["run-1", carried_cursor] },
        { options: { workflowID: intentWorkflowId("pending-child"), timeoutMS: DEFAULT_WORKFLOW_TIMING.execution_deadline_ms }, args: ["pending-child"] },
      ]);
    } finally { status.mockRestore(); start.mockRestore(); }
  });
}), 60_000);

const dispatchProbe = DBOS.registerWorkflow(async (intent_id: string, kind: "start" | "stop") =>
  dispatchChild("run-1", intent_id, kind), { name: "oakridgeDispatchReviewProbe" });
const storedPayload = (action: "start" | "stop") => sealEffectPayload({ action, handle: null,
  invocation: { id: "effect-1", execution_id: "execution-1", selection: {}, bytes: "pinned" } } as unknown as EffectPayload);

test("cancelled-child expiry retains its branch when replayed after the deadline", async () => withDatabase(async ({ url }) => {
  await withDBOS(url, async () => {
    const db = { query: async () => [{ id: "effect-1", run_id: "run-1", scope_id: "scope-1", execution_id: null, effect_key: "key",
      payload: storedPayload("start"), status: "pending", dispatch_generation: 0, redispatch_failures: 0, deadline_epoch_ms: null, version: 0 }] } as unknown as TransactionalSqlExecutor;
    registerWorkflowServices({ db, timing: DEFAULT_WORKFLOW_TIMING } as Parameters<typeof registerWorkflowServices>[0]);
    const deadline = Date.now() + 250;
    const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: "CANCELLED", deadlineEpochMS: deadline }) as never);
    let should_fail_resume = true;
    const resume = spyOn(DBOS, "resumeWorkflow").mockImplementation(async () => {
      if (should_fail_resume) throw new Error("resume unavailable");
      return {} as never;
    });
    try {
      const original = await DBOS.startWorkflow(dispatchProbe, { workflowID: "expiry-original" })("effect-1", "start");
      await expect(original.getResult()).rejects.toThrow("resume unavailable");
      const expiry = (await DBOS.listWorkflowSteps("expiry-original"))?.find((step) => step.name === "oakridgeEffectExpired");
      expect(expiry?.output).toBe(false);
      await Bun.sleep(Math.max(0, deadline - Date.now() + 50));
      should_fail_resume = false;
      await (await DBOS.forkWorkflow("expiry-original", expiry!.functionID + 1)).getResult();
      expect(resume).toHaveBeenCalledTimes(2);
    } finally { status.mockRestore(); resume.mockRestore(); }
  });
}), 20_000);

for (const kind of ["start", "stop"] as const) {
  for (const workflow_status of ["SUCCESS", "ERROR"] as const) {
    test(`${workflow_status} ${kind} dispatch tolerates an intent settled after the run scan`, async () => withDatabase(async ({ url }) => {
      await withDBOS(url, async () => {
        const db = { query: async () => [{ id: "effect-1", status: "cleanup_confirmed", version: 0, payload: storedPayload(kind) }] } as unknown as TransactionalSqlExecutor;
        registerWorkflowServices({ db, timing: DEFAULT_WORKFLOW_TIMING } as Parameters<typeof registerWorkflowServices>[0]);
        const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: workflow_status }) as never);
        try { await expect(dispatchChild("run-1", "effect-1", kind)).resolves.toBeUndefined(); }
        finally { status.mockRestore(); }
      });
    }), 20_000);
  }
}

test("a terminal child workflow still fails dispatch when its intent remains pending", async () => withDatabase(async ({ url }) => {
  await withDBOS(url, async () => {
    const db = { query: async () => [{ id: "effect-1", status: "pending", version: 0, payload: storedPayload("start") }] } as unknown as TransactionalSqlExecutor;
    registerWorkflowServices({ db } as Parameters<typeof registerWorkflowServices>[0]);
    const status = spyOn(DBOS, "getWorkflowStatus").mockImplementation(async () => ({ status: "SUCCESS" }) as never);
    try { await expect(dispatchChild("run-1", "effect-1", "start")).rejects.toThrow("intent remains pending"); }
    finally { status.mockRestore(); }
  });
}), 20_000);
