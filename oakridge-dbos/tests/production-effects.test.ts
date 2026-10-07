import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createProductionComposition } from "../src/runtime/compose";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";
import { readSnapshot } from "../src/storage/snapshot-reader";
import type { CheckedValue } from "../src/core-client/generated-contracts";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { EffectPayload } from "../src/effects/intents";
import type { StableInvocation } from "../src/effects/provider";
import { unit, withDatabase, waitUntil, operationBundle, sessionBundle, begin } from "./effect-fixture";
import type { StartedRun } from "../src/storage/mutation-service";
import { activeRoutes } from "../src/http/routes";
import { developmentBundle, brief, repository, build_body } from "./development-runtime-fixture";

test("recovery replays the pinned prompt verbatim and its secret publishes without operator authority", async () => {
  const requests: string[] = [];
  const adapter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (request.method === "PUT") {
      requests.push(await request.text());
      if (requests.length === 1) return new Response("response lost", { status: 503 });
      return Response.json({ kind: "attached", session: { sid: "recovered-session", status: "live" } });
    }
    if (request.method === "DELETE") return Response.json({ stopped: true });
    return Response.json({ pending: true }, { status: 202 });
  } });
  try {
    await withDatabase(async ({ url, db }) => {
      const composition = await createProductionComposition({ database_url: url,
        core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
        control_token: "operator-only", kbbl_base_url: adapter.url.href,
        provider_capabilities: { check_github: async () => ({ ok: true, value: true }) },
        timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
      try {
        const headers = { "content-type": "application/json", authorization: "Bearer operator-only" };
        const created = await composition.app.request("/runs", { method: "POST", headers,
          body: JSON.stringify({ bundle: await developmentBundle(), input: { brief, repository, push_remote_owner: repository.forge.owner } }) });
        expect(created.status).toBe(201);
        const run: StartedRun = await created.json();
        const scope_path = `/api/runs/${run.run_id}/scopes/${run.root_scope_id}`;
        const begin = await composition.app.request(`${scope_path}/commands`, { method: "POST", headers,
          body: JSON.stringify({ command_key: "begin", payload: {}, request_id: "begin", scope_id: run.root_scope_id,
            expected_scope_version: 0, targets: [] }) });
        expect(begin.status).toBe(202);
        await waitUntil(async () => requests.length >= 2);
        const pinned = (await db.query<{ payload: EffectPayload }>(
          "SELECT payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.payload.invocation;
        if (!pinned) throw new Error("persisted invocation missing");
        expect(requests).toEqual(requests.map(() => pinned.bytes));
        const secret = requests[1]?.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)?.[1];
        if (!secret) throw new Error("replayed prompt lacks publication credential");
        const execution_path = `${scope_path}/executions/${pinned.execution_id}`;
        expect((await composition.app.request(`${execution_path}/contract`, {
          headers: { authorization: `Bearer ${secret}` } })).status).toBe(200);
        const publication = await composition.app.request(`${execution_path}/outputs/build_result`, { method: "PUT",
          headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
          body: JSON.stringify({ request_id: "replayed-agent", predecessor_id: null, collection_key: "", body: build_body }) });
        expect({ status: publication.status, body: await publication.json() }).toMatchObject({ status: 201, body: { kind: "accepted_pending" } });
        expect((await composition.app.request(scope_path, { headers: { authorization: "Bearer operator-only" } })).status).toBe(200);
        expect((await composition.app.request(scope_path, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
      } finally { await composition.close(); }
    });
  } finally { adapter.stop(true); }
});

test("the composed app registers exactly the active route table and gates raw ingress", async () => {
  const previous = process.env.OAKRIDGE_ENABLE_RAW_INGRESS;
  try {
    for (const enabled of [false, true]) {
      if (enabled) process.env.OAKRIDGE_ENABLE_RAW_INGRESS = "1";
      else delete process.env.OAKRIDGE_ENABLE_RAW_INGRESS;
      await withDatabase(async ({ url }) => {
        const composition = await createProductionComposition({ database_url: url,
          core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1" });
        try {
          const registered = composition.app.routes.filter((route) => route.method !== "ALL")
            .map((route) => `${route.method} ${route.path}`).sort();
          expect(registered).toEqual(activeRoutes(enabled).map((route) => `${route.method} ${route.path}`).sort());
          const response = await composition.app.request("/runs/missing/scopes/missing/decide", {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          expect(response.status).toBe(enabled ? 400 : 404);
        } finally { await composition.close(); }
      });
    }
  } finally {
    if (previous === undefined) delete process.env.OAKRIDGE_ENABLE_RAW_INGRESS;
    else process.env.OAKRIDGE_ENABLE_RAW_INGRESS = previous;
  }
});

test("rejection after uncertainty cleans up even when its evidence makes the run terminal", async () => withDatabase(async ({ url, db }) => {
  let starts = 0;
  const stopped: StableInvocation[] = [];
  let can_confirm_stop = false;
  const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    timing: { retry_initial_seconds: 0.01, retry_cap_seconds: 0.05, wake_timeout_seconds: 0.05 },
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
    const shipped = await operationBundle("repository.prepare");
    const root = shipped.scopes[0]!;
    if (root.tree.kind !== "match") throw new Error("effect fixture must dispatch facts");
    const bundle: DefinitionBundle = { ...shipped, scopes: [{ ...root,
      facts: [...root.facts, { key: "worktree_unrecoverable", payload_schema: "text" }],
      tree: { ...root.tree, cases: [...root.tree.cases, { variant: "worktree_unrecoverable",
        node: { kind: "apply", id: "worktree_unrecoverable", actions: [], mutations: [],
          outcome: { kind: "literal", schema: "result", value: { kind: "withdrawn", value: {} } } } }] } }] };
    const run = await begin(composition, bundle, { repository_path: "/tmp", expected_head: null });
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
    const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
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

test("production rejects a lost worktree when the shipped scope declares no recovery fact", async () => {
  await withDatabase(async ({ url, db }) => {
    const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
    try {
      const run = await begin(composition, await operationBundle("repository.prepare"), { repository_path: `/tmp/missing-${crypto.randomUUID()}`, expected_head: null });
      await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.status === "rejected");
      expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.fact WHERE fact_key='worktree_unrecoverable'", []))[0]?.count).toBe("0");
    } finally { await composition.close(); }
  });
});

test("production PR discovery retries a real HTTP 503 and persists its selected result fact", async () => {
  let is_available = false;
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    calls++;
    if (!is_available) return new Response("unavailable", { status: 503 });
    return new URL(request.url).pathname.endsWith("/pulls") ? Response.json([{ number: 1, head: { ref: "head", repo: { full_name: "owner/repo" } }, base: { ref: "base" } }])
      : Response.json({ number: 1, html_url: "https://forge/pr/1", state: "open", head: { ref: "head", sha: "a".repeat(40) }, base: { ref: "base" }, merged: false, merged_at: null });
  } });
  try {
    await withDatabase(async ({ url, db }) => {
      const reader = new GithubPullRequestReader({ token: "test", api_base_url: server.url.href });
      const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1", pull_requests: reader, provider_capabilities: { check_github: async () => ({ ok: true, value: true }) }, timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
      try {
        const run = await begin(composition, await operationBundle("pull_request.observe"), { query: { owner: "owner", name: "repo", head_owner: "owner", head_branch: "head", base_branch: "base" } });
        await waitUntil(async () => calls >= 1 && (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]))[0]?.status === "pending");
        const before = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]);
        is_available = true;
        await waitUntil(async () => (await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
        const after = await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1", [run.root_scope_id]);
        expect(after[0]?.payload.invocation.bytes).toBe(before[0]?.payload.invocation.bytes);
        expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.fact WHERE fact_key='pr_observed'", []))[0]?.count).toBe("1");
      } finally { await composition.close(); }
    });
  } finally { server.stop(true); }
});

test("GitHub 403 publishes a typed auth fact and does not retry", async () => {
  let calls = 0;
  const reader = new GithubPullRequestReader({ token: "restricted", api_base_url: "http://unused" }, (async () => {
    calls++;
    return new Response("forbidden", { status: 403 });
  }) as unknown as typeof fetch);
  await withDatabase(async ({ url, db }) => {
    const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"),
      host: "127.0.0.1", pull_requests: reader, provider_capabilities: { check_github: async () => ({ ok: true, value: true }) }, timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
    try {
      const run = await begin(composition, await operationBundle("pull_request.observe"), { query: { owner: "owner", name: "repo", head_owner: "owner", head_branch: "head", base_branch: "base" } });
      await waitUntil(async () => (await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
      const facts = await db.query<{ fact_key: string }>("SELECT fact_key FROM authority.fact WHERE scope_id=$1", [run.root_scope_id]);
      expect({ calls, has_auth_fact: facts.some((fact) => fact.fact_key === "auth") }).toEqual({ calls: 1, has_auth_fact: true });
    } finally { await composition.close(); }
  });
});

test("a shipped unit session result commits an execution and confirms cleanup", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => request.method === "PUT"
    ? Response.json({ kind: "attached", session: { sid: "completed-session", status: "live" } })
    : Response.json({ session: { endReason: "subprocess_exited" }, exit_code: 0 }) });
  try {
    await withDatabase(async ({ url, db }) => {
      const composition = await createProductionComposition({ database_url: url,
        core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"),
        host: "127.0.0.1", kbbl_base_url: server.url.href,
        timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
      try {
        const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: "publish the result", workdir: "/tmp", session_name: "completed",
          session_identity: {}, worktree: { branchName: "selected", worktreeSubdir: "selected" } });
        await waitUntil(async () => (await db.query<{ status: string }>("SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.status === "cleanup_confirmed");
        expect((await db.query<{ status: string; result: CheckedValue }>("SELECT status,result FROM authority.execution WHERE scope_id=$1", [run.root_scope_id]))[0])
          .toMatchObject({ status: "terminal", result: { schema: "unit", data: { kind: "record", fields: [] } } });
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
        timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
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
