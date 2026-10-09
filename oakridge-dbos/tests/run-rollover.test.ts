import { expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createProductionComposition } from "../src/runtime/compose";
import { runWorkflowId, wakeRun } from "../src/workflows/topology";
import * as fixture from "./effect-fixture";
const { stubProviderCapabilities, unit, withDatabase } = fixture;

const binary = resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli");

test("authority persists the currently addressable run generation", async () => withDatabase(async ({ db }) => {
  const columns = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='authority' AND table_name='run' AND column_name='current_generation'`, []);
  expect(columns).toHaveLength(1);
}));

async function eventually(predicate: () => Promise<boolean>, timeout_ms = 45_000): Promise<void> {
  const until = Date.now() + timeout_ms;
  while (Date.now() < until) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for run rollover");
}

test("rollover persists its current address and cursor; wake and effect completion reach the successor after restart", async () => withDatabase(async ({ url, db }) => {
  const provider = {
    start: async () => ({ kind: "acknowledged" as const, value: { kind: "completed" as const, result: unit } }),
    observe: async () => { throw new Error("completed effects are not observed"); },
    stop: async () => ({ kind: "acknowledged" as const, value: { stopped: true as const } }),
  };
  let composition = await createProductionComposition({ database_url: url, core_binary: binary, host: "127.0.0.1",
    provider_capabilities: stubProviderCapabilities, effect_provider: provider, timing: { wake_timeout_seconds: 0.05 } });
  try {
    const bundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
    const created = await composition.app.request("http://localhost/runs", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input: {} }) });
    expect(created.status).toBe(201);
    const run: { run_id: string; root_scope_id: string } = await created.json();
    const generation = async () => Number((await db.query<{ current_generation: string }>(
      "SELECT current_generation FROM authority.run WHERE id=$1", [run.run_id]))[0]?.current_generation ?? -1);
    await eventually(async () => await generation() >= 1);
    const first_successor = await generation();
    await eventually(async () => (await DBOS.getWorkflowStatus(runWorkflowId(run.run_id)))?.status === "SUCCESS");
    expect((await DBOS.getWorkflowStatus(runWorkflowId(run.run_id, first_successor)))?.status).toMatch(/PENDING|ENQUEUED/);
    expect((await DBOS.getWorkflowStatus(runWorkflowId(run.run_id)))?.status).toBe("SUCCESS");

    const sent: string[] = [];
    const original_send = DBOS.send.bind(DBOS);
    const send = spyOn(DBOS, "send").mockImplementation(((workflow_id: string, message: unknown, topic?: string) => {
      sent.push(workflow_id);
      return original_send(workflow_id, message, topic);
    }) as never);
    try {
      const decided = await composition.app.request(`http://localhost/runs/${run.run_id}/scopes/${run.root_scope_id}/decide`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ingress_id: "begin",
          trigger: { id: "begin", key: "begin", payload: unit } }) });
      expect(decided.status).toBe(200);
      await eventually(async () => sent.some((id) => id.startsWith(`run:${run.run_id}:`)));
      expect(sent).not.toContain(runWorkflowId(run.run_id));
      const addressed = sent.find((id) => id.startsWith(`run:${run.run_id}:`))!;
      expect((await DBOS.getWorkflowStatus(addressed))?.status).toMatch(/PENDING|ENQUEUED|SUCCESS/);
    } finally { send.mockRestore(); }

    await composition.close();
    composition = await createProductionComposition({ database_url: url, core_binary: binary, host: "127.0.0.1",
      provider_capabilities: stubProviderCapabilities, effect_provider: provider, timing: { wake_timeout_seconds: 5 } });
    const current = await generation();
    expect(current).toBeGreaterThanOrEqual(1);
    expect((await DBOS.getWorkflowStatus(runWorkflowId(run.run_id, current)))?.status).toMatch(/PENDING|ENQUEUED/);
    await db.query("UPDATE authority.scope_instance SET is_terminal=true WHERE id=$1", [run.root_scope_id]);
    await wakeRun(run.run_id);
    await eventually(async () => (await DBOS.getWorkflowStatus(runWorkflowId(run.run_id, current)))?.status === "SUCCESS", 5_000);
  } finally { await composition.close(); }
}), 60_000);
