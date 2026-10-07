import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createProductionComposition } from "../src/runtime/compose";
import { DEFAULT_WORKFLOW_TIMING } from "../src/workflows/topology";
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
        expect((await DBOS.getWorkflowStatus(intent_id!))?.status).toBe("CANCELLED");
        return;
      }
      await Bun.sleep(25);
    }
    throw new Error(`effect ${intent_id ?? "missing"} did not settle after its DBOS timeout`);
  } finally { await composition.close(); }
}), 15_000);
