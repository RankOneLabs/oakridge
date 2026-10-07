import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createProductionComposition } from "../src/runtime/compose";
import { ensureRunWorkflow, runWorkflowId, wakeRun } from "../src/workflows/topology";
import * as topology from "../src/workflows/topology";
import { ensureStopIntent } from "../src/storage/revocation";
import type { EffectIntent } from "../src/effects/intents";
import { stubProviderCapabilities, unit, withDatabase } from "./effect-fixture";

const binary = resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli");

test("ERROR recovery forks at the first failed step after successful checkpoints", () => {
  const steps = [{ functionID: 0, error: null }, { functionID: 1, error: null },
    { functionID: 2, error: new Error("failed") }];
  expect(topology.forkStartStep(steps)).toBe(2);
});

async function eventually(predicate: () => Promise<boolean>, timeout_ms = 20_000): Promise<void> {
  const until = Date.now() + timeout_ms;
  while (Date.now() < until) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for DBOS run recovery");
}

async function activeRun(composition: Awaited<ReturnType<typeof createProductionComposition>>): Promise<{ run_id: string; root_scope_id: string }> {
  const bundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
  const response = await composition.app.request("http://localhost/runs", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input: {} }) });
  expect(response.status).toBe(201);
  return response.json();
}

test("startup forks an ERROR run from its last good step and advances it; PENDING is left alone", async () => withDatabase(async ({ url, db }) => {
  let composition = await createProductionComposition({ database_url: url, core_binary: binary, host: "127.0.0.1",
    timing: { wake_timeout_seconds: 5 } });
  try {
    const run = await activeRun(composition);
    await eventually(async () => (await DBOS.getWorkflowStatus(runWorkflowId(run.run_id)))?.status === "PENDING");
    await ensureRunWorkflow(run.run_id);
    expect((await db.query<{ current_generation: string }>("SELECT current_generation FROM authority.run WHERE id=$1", [run.run_id]))[0]?.current_generation).toBe("0");
    await composition.close();
    await db.query("UPDATE dbos.workflow_status SET status='ERROR' WHERE workflow_uuid=$1", [runWorkflowId(run.run_id)]);

    composition = await createProductionComposition({ database_url: url, core_binary: binary, host: "127.0.0.1",
      timing: { wake_timeout_seconds: 5 } });
    await eventually(async () => (await db.query<{ current_generation: string }>("SELECT current_generation FROM authority.run WHERE id=$1", [run.run_id]))[0]?.current_generation === "1");
    expect((await DBOS.getWorkflowStatus(runWorkflowId(run.run_id, 1)))?.forkedFrom).toBe(runWorkflowId(run.run_id));
    await db.query("UPDATE authority.scope_instance SET is_terminal=true WHERE id=$1", [run.root_scope_id]);
    await wakeRun(run.run_id);
    await eventually(async () => (await DBOS.getWorkflowStatus(runWorkflowId(run.run_id, 1)))?.status === "SUCCESS");
  } finally { await composition.close(); }
}), 30_000);

test("wake detects an ERROR run and forks the address before sending", async () => withDatabase(async ({ url, db }) => {
  const composition = await createProductionComposition({ database_url: url, core_binary: binary, host: "127.0.0.1",
    timing: { wake_timeout_seconds: 5 } });
  try {
    const run = await activeRun(composition);
    await eventually(async () => (await DBOS.getWorkflowStatus(runWorkflowId(run.run_id)))?.status === "PENDING");
    await DBOS.cancelWorkflow(runWorkflowId(run.run_id));
    await eventually(async () => (await DBOS.getWorkflowStatus(runWorkflowId(run.run_id)))?.status === "CANCELLED");
    await db.query("UPDATE dbos.workflow_status SET status='ERROR' WHERE workflow_uuid=$1", [runWorkflowId(run.run_id)]);
    await wakeRun(run.run_id);
    await eventually(async () => (await db.query<{ current_generation: string }>("SELECT current_generation FROM authority.run WHERE id=$1", [run.run_id]))[0]?.current_generation === "1");
    expect((await DBOS.getWorkflowStatus(runWorkflowId(run.run_id, 1)))?.forkedFrom).toBe(runWorkflowId(run.run_id));
    await db.query("UPDATE authority.scope_instance SET is_terminal=true WHERE id=$1", [run.root_scope_id]);
    await wakeRun(run.run_id);
    await eventually(async () => (await DBOS.getWorkflowStatus(runWorkflowId(run.run_id, 1)))?.status === "SUCCESS");
  } finally { await composition.close(); }
}), 30_000);

test("startup adopts a recovery fork committed before the authority address changed", async () => withDatabase(async ({ url, db }) => {
  let composition = await createProductionComposition({ database_url: url, core_binary: binary, host: "127.0.0.1",
    timing: { wake_timeout_seconds: 5 } });
  try {
    const run = await activeRun(composition);
    const original_id = runWorkflowId(run.run_id);
    const successor_id = runWorkflowId(run.run_id, 1);
    await eventually(async () => (await DBOS.getWorkflowStatus(original_id))?.status === "PENDING");
    const application_version = composition.application_version;
    await composition.close();
    await db.query("UPDATE dbos.workflow_status SET status='ERROR' WHERE workflow_uuid=$1", [original_id]);
    DBOS.setConfig({ name: "oakridge-recovery-probe", systemDatabaseUrl: url, applicationVersion: "recovery-probe" });
    await DBOS.launch();
    try {
      const steps = await DBOS.listWorkflowSteps(original_id) ?? [];
      await DBOS.forkWorkflow(original_id, topology.forkStartStep(steps),
        { newWorkflowID: successor_id, applicationVersion: application_version });
    } finally { await DBOS.shutdown(); }
    composition = await createProductionComposition({ database_url: url, core_binary: binary, host: "127.0.0.1",
      timing: { wake_timeout_seconds: 5 } });
    expect((await db.query<{ current_generation: string }>(
      "SELECT current_generation FROM authority.run WHERE id=$1", [run.run_id]))[0]?.current_generation).toBe("1");
    await eventually(async () => (await DBOS.getWorkflowStatus(successor_id))?.status === "PENDING");
    await db.query("UPDATE authority.scope_instance SET is_terminal=true WHERE id=$1", [run.root_scope_id]);
    await wakeRun(run.run_id);
    await eventually(async () => (await DBOS.getWorkflowStatus(successor_id))?.status === "SUCCESS");
  } finally { await composition.close(); }
}), 30_000);

test("startup finishes cleanup for a terminal root and later wakes preserve the completed generation", async () => withDatabase(async ({ url, db }) => {
  let stop_calls = 0;
  const options = { database_url: url, core_binary: binary, host: "127.0.0.1",
    provider_capabilities: stubProviderCapabilities, timing: { wake_timeout_seconds: 0.05 },
    effect_provider: {
      start: async () => ({ kind: "acknowledged" as const, value: { kind: "completed" as const, result: unit } }),
      observe: async () => ({ kind: "acknowledged" as const, value: { kind: "running" as const } }),
      stop: async () => { stop_calls++; return { kind: "acknowledged" as const, value: { stopped: true as const } }; },
    },
  };
  let composition = await createProductionComposition(options);
  try {
    const run = await activeRun(composition);
    const response = await composition.app.request(`http://localhost/runs/${run.run_id}/scopes/${run.root_scope_id}/decide`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ingress_id: "begin",
        trigger: { id: "begin", key: "begin", payload: unit } }),
    });
    expect(response.status).toBe(200);
    await eventually(async () => (await db.query<EffectIntent>(
      "SELECT * FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.status === "cleanup_confirmed");
    await composition.close();
    const start = (await db.query<EffectIntent>("SELECT * FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]!;
    const stop_id = await db.transaction(async (tx) => {
      await tx.query("UPDATE authority.scope_instance SET is_terminal=true WHERE id=$1", [run.root_scope_id]);
      return ensureStopIntent(tx, start);
    });
    composition = await createProductionComposition(options);
    await eventually(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE id=$1", [stop_id]))[0]?.status === "cleanup_confirmed");
    const generation = (await db.query<{ current_generation: string }>("SELECT current_generation FROM authority.run WHERE id=$1", [run.run_id]))[0]!.current_generation;
    await eventually(async () => (await DBOS.getWorkflowStatus(runWorkflowId(run.run_id, Number(generation))))?.status === "SUCCESS");
    expect(stop_calls).toBe(1);
    await wakeRun(run.run_id); await wakeRun(run.run_id);
    expect((await db.query<{ current_generation: string }>("SELECT current_generation FROM authority.run WHERE id=$1", [run.run_id]))[0]?.current_generation).toBe(generation);
  } finally { await composition.close(); }
}), 30_000);
