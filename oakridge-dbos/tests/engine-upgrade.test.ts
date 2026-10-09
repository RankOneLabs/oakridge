import { expect, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { resolve } from "node:path";
import { createProductionComposition, type ProductionOptions } from "../src/runtime/compose";
import type { EffectProvider } from "../src/effects/provider";
import { intentWorkflowId, runWorkflowId } from "../src/workflows/topology";
import { begin, sessionBundle, unit, waitUntil, withDatabase } from "./effect-fixture";

const FAST = { retry_initial_seconds: 0.01, retry_cap_seconds: 0.02, observe_interval_seconds: 0.01, wake_timeout_seconds: 0.02 };

test("a session parked by one engine version completes under the next", async () => withDatabase(async ({ url, db }) => {
  let is_finished = false;
  const provider: EffectProvider = {
    start: async () => ({ kind: "acknowledged", value: { kind: "kbbl_session", session_id: "session" } }),
    observe: async () => ({ kind: "acknowledged", value: is_finished ? { kind: "terminal", result: unit } : { kind: "running" } }),
    stop: async () => ({ kind: "acknowledged", value: { stopped: true } }),
  } as EffectProvider;
  const options = (application_version: string): ProductionOptions => ({ database_url: url, application_version,
    core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    timing: FAST, effect_provider: provider });
  const startIntent = async () => (await db.query<{ id: string; status: string }>(
    "SELECT e.id,e.status FROM authority.effect_intent e JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1 AND e.payload->>'action'='start'", [run_id]))[0];
  let run_id = "";

  let composition = await createProductionComposition(options("engine-a"));
  try {
    const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: "observe", workdir: "/tmp",
      session_name: "upgrade", session_identity: {}, worktree: { branchName: "selected", worktreeSubdir: "selected" } });
    run_id = run.run_id;
    await waitUntil(async () => (await startIntent())?.status === "acknowledged");
  } finally { await composition.close(); }
  const intent_id = (await startIntent())!.id;
  is_finished = true;

  composition = await createProductionComposition(options("engine-b"));
  try {
    await waitUntil(async () => (await startIntent())?.status === "cleanup_confirmed");
    await waitUntil(async () => (await DBOS.getWorkflowStatus(intentWorkflowId(intent_id, "engine-b")))?.status === "SUCCESS");
    const generation = Number((await db.query<{ current_generation: string }>(
      "SELECT current_generation FROM authority.run WHERE id=$1", [run_id]))[0]!.current_generation);
    const [parked, carried, run] = await Promise.all([DBOS.getWorkflowStatus(intentWorkflowId(intent_id, "engine-a")),
      DBOS.getWorkflowStatus(intentWorkflowId(intent_id, "engine-b")), DBOS.getWorkflowStatus(runWorkflowId(run_id, generation))]);
    expect({ parked: [parked?.status, parked?.applicationVersion], carried: [carried?.status, carried?.applicationVersion],
      run: run?.applicationVersion, carried_over: generation > 0 }).toEqual({
      parked: ["CANCELLED", "engine-a"], carried: ["SUCCESS", "engine-b"], run: "engine-b", carried_over: true });
  } finally { await composition.close(); }
}), 30_000);
