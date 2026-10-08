import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createProductionComposition } from "../src/runtime/compose";
import { intentWorkflowId, wakeRun } from "../src/workflows/topology";
import { begin, sessionBundle, withDatabase } from "./effect-fixture";
import { sealEffectPayload } from "../src/storage/effect-secret";
import type { EffectPayload } from "../src/effects/intents";

const topology = readFileSync(resolve(import.meta.dir, "../src/workflows/topology.ts"), "utf8");
const completedChild = DBOS.registerWorkflow(async (): Promise<null> => null, { name: "oakridgeTestCompletedChild" });

test("run bodies keep child dispatch and scope lookup in durable DBOS operations", () => {
  expect(topology).not.toContain("const started = new Set");
  const wake_body = topology.split("async function wakeRunOf(")[1]?.split("const runOfScopeStep")[0];
  expect(wake_body).toBeDefined();
  expect(wake_body).not.toContain(".db.query");
  const run_body = topology.split("export const runWorkflow =")[1]?.split("// ------------------------------------------------------------- entry")[0];
  expect(run_body).not.toContain(".db.query");
});

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

test("a loop-boundary dispatch failure strands the run as a typed, visible ERROR", async () => withDatabase(async ({ url, db }) => {
  const composition = await createProductionComposition({ database_url: url,
    core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    timing: { wake_timeout_seconds: 5 } });
  try {
    const bundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
    const response = await composition.app.request("http://localhost/runs", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input: {} }) });
    expect(response.status).toBe(201);
    const run: { run_id: string; root_scope_id: string } = await response.json();
    const intent_id = crypto.randomUUID();
    await (await DBOS.startWorkflow(completedChild, { workflowID: intentWorkflowId(intent_id) })()).getResult();
    await db.query(`INSERT INTO authority.effect_intent (id,run_id,scope_id,effect_key,payload,status)
      VALUES ($1,$2,$3,$4,$5,'pending')`, [intent_id, run.run_id, run.root_scope_id, "inconsistent-child",
        JSON.stringify(sealEffectPayload({ action: "start", handle: null,
          invocation: { id: intent_id, execution_id: "execution-1", selection: {}, bytes: "pinned" } } as unknown as EffectPayload))]);
    await wakeRun(run.run_id);
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      const status = await DBOS.getWorkflowStatus(`run:${run.run_id}`);
      if (status?.status === "ERROR") {
        expect(String(status.error)).toContain("RunInfrastructureError");
        expect(String(status.error)).toContain(intent_id);
        return;
      }
      await Bun.sleep(25);
    }
    throw new Error("run did not expose its dispatch failure in DBOS ERROR");
  } finally { await composition.close(); }
}), 15_000);
