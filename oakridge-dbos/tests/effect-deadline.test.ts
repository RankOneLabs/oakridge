import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createProductionComposition } from "../src/runtime/compose";
import { DEFAULT_WORKFLOW_TIMING, intentWorkflowId } from "../src/workflows/topology";
import { begin, sessionBundle, withDatabase } from "./effect-fixture";

test("effect workflows have a finite execution deadline by default", () => {
  expect(DEFAULT_WORKFLOW_TIMING.execution_deadline_ms).toBeGreaterThan(0);
});

test("execution_deadline_ms cancels a long-running effect and records a visible rejection", async () => withDatabase(async ({ url, db }) => {
  const composition = await createProductionComposition({ database_url: url,
    core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    timing: { execution_deadline_ms: 200, observe_interval_seconds: 0.05, wake_timeout_seconds: 0.05 },
    effect_provider: {
      start: async () => ({ kind: "acknowledged", value: { kind: "kbbl_session", session_id: "slow-session" } }),
      observe: async () => ({ kind: "acknowledged", value: { kind: "running" } }),
      stop: async () => ({ kind: "acknowledged", value: { stopped: true } }),
    } });
  try {
    const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: "wait",
      workdir: "/tmp", session_name: "deadline", session_identity: {}, worktree: { branchName: "selected", worktreeSubdir: "selected" } });
    let intent_id: string | null = null;
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const rows = await db.query<{ id: string; status: string; payload: { failure?: { detail: string } } }>(
        "SELECT id,status,payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]);
      intent_id = rows[0]?.id ?? null;
      if (rows[0]?.status === "rejected") {
        expect(rows[0].payload.failure?.detail).toContain("execution deadline exceeded");
        expect((await DBOS.getWorkflowStatus(intentWorkflowId(intent_id!)))?.status).toBe("CANCELLED");
        return;
      }
      await Bun.sleep(25);
    }
    throw new Error(`effect ${intent_id ?? "missing"} did not settle after its DBOS timeout`);
  } finally { await composition.close(); }
}), 15_000);

test("startup settles an expired CANCELLED effect with evidence instead of resuming it", async () => withDatabase(async ({ url, db }) => {
  const options = { database_url: url,
    core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    timing: { execution_deadline_ms: 60_000, observe_interval_seconds: 0.05, wake_timeout_seconds: 5 },
    effect_provider: {
      start: async () => ({ kind: "acknowledged" as const, value: { kind: "kbbl_session" as const, session_id: "restart-session" } }),
      observe: async () => ({ kind: "acknowledged" as const, value: { kind: "running" as const } }),
      stop: async () => ({ kind: "acknowledged" as const, value: { stopped: true as const } }),
    },
  };
  let composition = await createProductionComposition(options);
  try {
    const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: "wait",
      workdir: "/tmp", session_name: "restart-deadline", session_identity: {},
      worktree: { branchName: "selected", worktreeSubdir: "selected" } });
    let intent_id: string | null = null;
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const rows = await db.query<{ id: string; status: string }>(
        "SELECT id,status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]);
      intent_id = rows[0]?.id ?? null;
      if (rows[0]?.status === "acknowledged" && (await DBOS.getWorkflowStatus(intentWorkflowId(intent_id!)))?.status === "PENDING") break;
      await Bun.sleep(25);
    }
    if (!intent_id) throw new Error("effect intent was not dispatched");
    const workflow_id = intentWorkflowId(intent_id);
    await composition.close();
    // The authority column is the source of truth for the deadline across a
    // restart; the SDK's own workflow_deadline_epoch_ms is NULLed by the resume
    // this restart performs, so backdating it here would prove nothing.
    await db.query("UPDATE authority.effect_intent SET deadline_epoch_ms=$2 WHERE id=$1", [intent_id, Date.now() - 1_000]);
    composition = await createProductionComposition(options);
    const after = Date.now() + 10_000;
    let payload: { failure?: { detail: string }; evidence_delivered?: boolean } | null = null;
    while (Date.now() < after) {
      const rows = await db.query<{ status: string; payload: { failure?: { detail: string }; evidence_delivered?: boolean } }>(
        "SELECT status,payload FROM authority.effect_intent WHERE id=$1", [intent_id]);
      if (rows[0]?.status === "rejected") { payload = rows[0].payload; break; }
      await Bun.sleep(25);
    }
    expect(payload?.failure?.detail).toContain("execution deadline exceeded");
    expect(payload?.evidence_delivered).toBe(true);
    expect((await DBOS.getWorkflowStatus(workflow_id))?.status).toBe("CANCELLED");
  } finally { await composition.close(); }
}), 25_000);
