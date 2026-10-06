import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createProductionComposition } from "../src/runtime/compose";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";
import { readSnapshot } from "../src/storage/snapshot-reader";
import type { CheckedValue } from "../src/core-client/generated-contracts";
import type { EffectPayload } from "../src/effects/intents";
import type { StableInvocation } from "../src/effects/provider";
import { unit, withDatabase, waitUntil, operationBundle, begin } from "./effect-fixture";

test("rejection after uncertainty cleans up even when its evidence makes the run terminal", async () => withDatabase(async ({ url, db }) => {
  let starts = 0;
  const stopped: StableInvocation[] = [];
  let can_confirm_stop = false;
  const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    timing: { provider_timeout_ms: 500, retry_initial_seconds: 0.01, retry_cap_seconds: 0.05, wake_timeout_seconds: 0.05 },
    effect_provider: {
      start: async () => ++starts === 1 ? { kind: "uncertain", detail: "start response lost" }
        : { kind: "permanently_rejected", code: "worktree_unrecoverable", detail: "reconciliation rejected",
          evidence: { id: "rejection", key: "worktree_unrecoverable", payload: { schema: "text", data: { kind: "string", value: "reconciliation rejected" } } } },
      observe: async () => { throw new Error("rejected starts must not be observed"); },
      stop: async (invocation) => {
        stopped.push(invocation);
        return can_confirm_stop ? { kind: "acknowledged", value: { stopped: true } } : { kind: "uncertain", detail: "stop response lost" };
      },
    } });
  try {
    const run = await begin(composition, await operationBundle("repository.prepare"), { repository_path: "/tmp", expected_head: null });
    await waitUntil(async () => stopped.length > 0 && (await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
    const deletion = await composition.app.request(`http://localhost/runs/${run.run_id}`, { method: "DELETE" });
    expect(deletion.status).toBe(409);
    can_confirm_stop = true;
    await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='stop'", [run.root_scope_id]))[0]?.status === "cleanup_confirmed");
    const start = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]);
    expect(stopped.every((invocation) => invocation.bytes === start[0]?.payload.invocation.bytes)).toBe(true);
    expect((await composition.app.request(`http://localhost/runs/${run.run_id}`, { method: "DELETE" })).status).toBe(200);
  } finally { await composition.close(); }
}));

test("production prepares the selected repository and routes durable results into configured scope decisions", async () => {
  await withDatabase(async ({ url, db }) => {
    const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", timing: { provider_timeout_ms: 500, retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
    try {
      const bundle = await operationBundle("repository.prepare");
      const run = await begin(composition, bundle, { repository_path: resolve(import.meta.dir, "../.."), expected_head: null });
      await waitUntil(async () => (await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
      const facts = await db.query<{ fact_key: string }>("SELECT fact_key FROM authority.fact WHERE scope_id=$1", [run.root_scope_id]);
      expect(facts.some((fact) => fact.fact_key === "prepared")).toBe(true);
      const source = await readSnapshot(db, run.root_scope_id, { id: "tick", key: "tick", payload: unit });
      expect(source?.snapshot.observations).toEqual([]);
      const effects = await db.query<{ payload: EffectPayload; status: string }>("SELECT payload,status FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]);
      expect(effects[0]?.status).toBe("cleanup_confirmed");
      expect(effects[0]?.payload.invocation.selection.definition.operation).toBe("repository.prepare");
    } finally { await composition.close(); }
  });
});

test("production routes lost-worktree evidence to the scope's configured recovery", async () => {
  await withDatabase(async ({ url, db }) => {
    const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", timing: { provider_timeout_ms: 500, retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
    try {
      const run = await begin(composition, await operationBundle("repository.prepare"), { repository_path: `/tmp/missing-${crypto.randomUUID()}`, expected_head: null });
      await waitUntil(async () => (await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
      const scope = await db.query<{ outcome: CheckedValue }>("SELECT outcome FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]);
      expect(scope[0]?.outcome.data).toMatchObject({ kind: "variant", variant: "withdrawn" });
      expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.fact WHERE fact_key='worktree_unrecoverable'", []))[0]?.count).toBe("1");
    } finally { await composition.close(); }
  });
});

test("production PR discovery retries a real HTTP 503 and persists its selected result fact", async () => {
  let is_available = false;
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    calls++;
    if (!is_available) return new Response("unavailable", { status: 503 });
    return new URL(request.url).pathname.endsWith("/pulls") ? Response.json([{ number: 1 }])
      : Response.json({ number: 1, html_url: "https://forge/pr/1", state: "open", head: { ref: "head", sha: "a".repeat(40) }, base: { ref: "base" }, merged: false, merged_at: null });
  } });
  try {
    await withDatabase(async ({ url, db }) => {
      const reader = new GithubPullRequestReader({ token: "test", api_base_url: server.url.href });
      const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", pull_requests: reader, timing: { provider_timeout_ms: 500, retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
      try {
        const run = await begin(composition, await operationBundle("pull_request.observe"), { query: { owner: "owner", name: "repo", head_branch: "head", base_branch: "base" } });
        await waitUntil(async () => calls >= 1 && (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]))[0]?.status === "pending");
        const before = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]);
        is_available = true;
        await waitUntil(async () => (await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
        const after = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]);
        expect(after[0]?.payload.invocation.bytes).toBe(before[0]?.payload.invocation.bytes);
        expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.fact WHERE fact_key='prepared'", []))[0]?.count).toBe("1");
      } finally { await composition.close(); }
    });
  } finally { server.stop(true); }
});

test("changed repository head and PR observations cannot enrich a selected kbbl request on replay", async () => {
  const { sessionBundle } = await import("./effect-fixture");
  const requests: string[] = [];
  let should_attach = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (request.method === "PUT") {
      requests.push(await request.text());
      return should_attach ? Response.json({ kind: "attached", session: { sid: "one-session", status: "live" } }) : new Response("accepted, response lost", { status: 503 });
    }
    if (request.method === "DELETE") return Response.json({ stopped: true });
    return Response.json({ pending: true }, { status: 202 });
  } });
  try {
    await withDatabase(async ({ url, db }) => {
      const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", kbbl_base_url: server.url.href,
        timing: { provider_timeout_ms: 500, retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
      try {
        const selected_head = "a".repeat(40);
        const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: `Review PR 1 at ${selected_head}`, workdir: "/tmp", session_name: "replay",
          session_identity: { run_id: "selected-run", stage_instance_id: "selected-scope", unit_id: "author" }, worktree: { branchName: "selected", worktreeSubdir: "selected", baseRef: selected_head } });
        await waitUntil(async () => requests.length >= 1 && (await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.payload.has_uncertain_start === true);
        for (const key of ["repository", "pull_request"]) {
          const changed: CheckedValue = { schema: "metadata", data: { kind: "record", fields: [], dictionary: [{ key: key === "repository" ? "head" : "url", value: { schema: "text", data: { kind: "string", value: key === "repository" ? "b".repeat(40) : "https://forge/pr/2" } } }] } };
          await db.query("INSERT INTO authority.resource_binding (id,scope_id,resource_key,observation) VALUES ($1,$2,$3,$4)", [key, run.root_scope_id, key, JSON.stringify(changed)]);
        }
        should_attach = true;
        await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.status === "acknowledged");
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(new Set(requests).size).toBe(1);
        const cancelled = await composition.app.request(`http://localhost/runs/${run.run_id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "cancel_run", reason: "operator" }) });
        expect(await cancelled.json()).toMatchObject({ kind: "cancelled" });
        await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='stop'", [run.root_scope_id]))[0]?.status === "cleanup_confirmed");
      } finally { await composition.close(); }
    });
  } finally { server.stop(true); }
});
