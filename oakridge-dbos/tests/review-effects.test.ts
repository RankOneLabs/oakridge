import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import type { CheckedValue, DefinitionBundle, Schema } from "../src/core-client/generated-contracts";
import { createMutationService, type MutationService, type StartedRun } from "../src/storage/mutation-service";
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { cancelRun, deleteRun } from "../src/storage/mutation-service";
import type { StableInvocation } from "../src/effects/provider";
import { readIntent } from "../src/effects/intents";
import { createEffectProvider } from "../src/effects/operations/production-provider";
import { asKbblCredential } from "../src/adapters/kbbl";
import { createProductionComposition } from "../src/runtime/compose";
import { operationBundle, sessionBundle, unit, waitUntil, withDatabase } from "./effect-fixture";

interface SelectionInput { readonly bundle: DefinitionBundle; readonly input: unknown }
interface SelectedRun { readonly db: PgPostgresExecutor; readonly core: CoreClient; readonly mutations: MutationService; readonly run: StartedRun; readonly invocation: StableInvocation }
async function withSelection(input: SelectionInput, operation: (fixture: SelectedRun) => Promise<void>): Promise<void> {
  await withDatabase(async ({ db }) => {
    const started_core = CoreClient.start({ binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), deadlineMs: 1000 });
    if (!started_core.ok) throw new Error(JSON.stringify(started_core.error));
    const core = started_core.value;
    try {
      const mutations = createMutationService(db, core);
      const run = await mutations.startRun({ ...input });
      if (!run.ok) throw new Error(JSON.stringify(run.error));
      const result = await mutations.decide({ run_id: run.value.run_id, scope_id: run.value.root_scope_id, ingress_id: "begin", trigger: { id: "begin", key: "begin", payload: unit }, operator_version: null });
      if (!result.ok || result.value.kind !== "Committed") throw new Error(JSON.stringify(result));
      const rows = await db.query<{ id: string }>("SELECT id FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.value.root_scope_id]);
      const invocation = rows[0] ? (await readIntent(db, rows[0].id))?.payload.invocation : null;
      if (!invocation) throw new Error("selected invocation missing");
      await operation({ db, core, mutations, run: run.value, invocation });
    } finally { core.close(); }
  });
}

for (const cancellation of ["run", "decision"] as const) {
  test(`${cancellation} cancellation creates no stop for a definite permanent rejection`, async () => {
    const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
    await withSelection({ bundle, input: {} }, async ({ db, core, mutations, run }) => {
      await db.query("UPDATE authority.effect_intent SET status='rejected' WHERE payload->>'action'='start'", []);
      if (cancellation === "run") expect(await cancelRun(db, { kind: "cancel_run", run_id: run.run_id, reason: "operator" }, core)).toMatchObject({ kind: "cancelled", stop_intents: 0 });
      else expect(await mutations.decide({ run_id: run.run_id, scope_id: run.root_scope_id, ingress_id: "cancel", trigger: { id: "cancel", key: "cancel", payload: unit }, operator_version: null })).toMatchObject({ ok: true, value: { kind: "Committed" } });
      expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.effect_intent WHERE payload->>'action'='stop'", []))[0]?.count).toBe("0");
      expect(await deleteRun(db, run.run_id)).toEqual({ kind: "deleted" });
    });
  });
}

test("run cancellation revokes a never-dispatched selection without manufacturing cleanup", async () => {
  const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
  await withSelection({ bundle, input: {} }, async ({ db, core, run }) => {
    expect(await cancelRun(db, { kind: "cancel_run", run_id: run.run_id, reason: "operator" }, core)).toMatchObject({ kind: "cancelled", stop_intents: 0 });
    expect(await deleteRun(db, run.run_id)).toEqual({ kind: "deleted" });
  });
});

test("production replay sends persisted HTTP bytes despite changed launch rendering input", async () => {
  const puts: Array<{ body: string; path: string }> = [];
  const lookups: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (request.method === "PUT") { puts.push({ body: await request.text(), path: new URL(request.url).pathname }); return Response.json({ kind: "attached", session: { sid: "one-session", status: "live" } }); }
    // A null reference on stop resolves by GET lookup rather than a second PUT (it must never
    // re-render or re-send launch bytes), so the stub answers that lookup with the same session.
    if (request.method === "GET") { lookups.push(new URL(request.url).pathname); return Response.json({ kind: "attached", session: { sid: "one-session", status: "live" } }); }
    return Response.json({ stopped: true });
  } });
  try {
    await withSelection({ bundle: await sessionBundle(), input: { runtime: "claude-code", rendered_prompt: "original selected prompt", workdir: "/tmp", session_name: "replay",
      session_identity: { run_id: "selected-run", stage_instance_id: "selected-scope", unit_id: "author" }, worktree: { branchName: "selected", worktreeSubdir: "selected", baseRef: "a".repeat(40) } } }, async ({ db, core, invocation }) => {
      const provider = createEffectProvider({ db, core, kbbl_base_url: server.url.href, credential: asKbblCredential("test-token") });
      const changed: StableInvocation = { ...invocation, selection: { ...invocation.selection, prompt_key: "new_adapter_rendering",
        input: { schema: "launch", data: { kind: "record", fields: [], dictionary: [] } } } };
      expect(await provider.start(changed)).toMatchObject({ kind: "acknowledged" });
      expect(await provider.stop(changed, null)).toEqual({ kind: "acknowledged", value: { stopped: true } });
      // Exactly one PUT, carrying the originally pinned bytes — stop never re-renders or re-sends.
      expect(puts.map((request) => request.body)).toEqual([invocation.bytes]);
      // The lookup that resolves the null reference asks about the same session key the start used.
      expect(lookups).toEqual(puts.map((request) => request.path));
    });
  } finally { server.stop(true); }
});

test("finite operation cleanup aborts an in-flight read and waits for confirmed IO completion", async () => {
  await withSelection({ bundle: await operationBundle("repository.prepare"), input: { repository_path: "/repo", expected_head: null } }, async ({ db, core, invocation }) => {
    let has_started = false;
    let has_aborted = false;
    let finish_io = (): void => {};
    const provider = createEffectProvider({ db, core, kbbl_base_url: "http://unused", credential: asKbblCredential("test-token"), git: { run: async (_path, _args, options) => {
      has_started = true;
      await new Promise<void>((resolve) => { finish_io = resolve; options?.signal?.addEventListener("abort", () => { has_aborted = true; }, { once: true }); });
      return { exit_code: 130, stdout: "", stderr: "aborted" };
    } } });
    const started = provider.start(invocation);
    await waitUntil(async () => has_started);
    let has_confirmed_cleanup = false;
    const stopped = provider.stop(invocation, null).then((result) => { has_confirmed_cleanup = true; return result; });
    await waitUntil(async () => has_aborted);
    expect(has_confirmed_cleanup).toBe(false);
    finish_io();
    expect(await stopped).toEqual({ kind: "acknowledged", value: { stopped: true } });
    expect(await started).toMatchObject({ kind: "transiently_unavailable" });
  });
});

interface CancellationCase { readonly name: string; readonly schemas: readonly Schema[]; readonly payload: unknown }
const cancellation_cases: readonly CancellationCase[] = [
  { name: "integer", schemas: [{ key: "cancel_payload", shape: { kind: "integer", min: 0, max: 100 } }], payload: 17 },
  { name: "record", schemas: [{ key: "cancel_payload", shape: { kind: "record", fields: [{ key: "reason", schema: "text", required: true }], dictionary: null } }], payload: { reason: "operator" } },
  { name: "variant", schemas: [{ key: "cancel_payload", shape: { kind: "union", variants: [{ key: "stop", schema: "unit" }] } }], payload: { kind: "stop", value: {} } },
  { name: "list", schemas: [{ key: "cancel_payload", shape: { kind: "list", item: "text", max_items: 10 } }], payload: ["operator"] },
];
for (const cancellation of cancellation_cases) {
  test(`HTTP cancellation validates an explicit ${cancellation.name} payload using the declared trigger schema`, async () => {
    await withDatabase(async ({ db, url }) => {
      const original: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
      const bundle: DefinitionBundle = { ...original, schemas: [...original.schemas, ...cancellation.schemas], scopes: original.scopes.map((scope) => ({ ...scope, cancellation: { ...scope.cancellation, payload: { kind: "literal", value: cancellation.payload } }, commands: scope.commands.map((command) => command.key === scope.cancellation.trigger ? { ...command, payload_schema: "cancel_payload" } : command) })) };
      const composition = await createProductionComposition({ database_url: url, core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1" });
      try {
        const created = await composition.app.request("http://localhost/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input: {} }) });
        if (created.status !== 201) throw new Error(await created.text());
        const run: StartedRun = await created.json();
        const cancel = (payload: unknown) => composition.app.request(`http://localhost/runs/${run.run_id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "cancel_run", reason: "operator", payloads: [{ scope_id: run.root_scope_id, payload }] }) });
        const invalid = await cancel(null);
        expect(invalid.status).toBe(422);
        expect((await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal).toBe(false);
        const cancelled = await cancel(cancellation.payload);
        expect(cancelled.status).toBe(200);
        expect((await db.query<{ payload: CheckedValue }>("SELECT payload FROM authority.fact WHERE fact_key='cancel'", []))[0]?.payload.schema).toBe("cancel_payload");
        const next = await composition.app.request("http://localhost/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input: {} }) });
        expect(next.status).toBe(201);
        const automatic_run: StartedRun = await next.json();
        const automatic_cancel = await composition.app.request(`http://localhost/runs/${automatic_run.run_id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "cancel_run", reason: "automatic" }) });
        expect(automatic_cancel.status).toBe(200);
        const facts = await db.query<{ payload: CheckedValue }>("SELECT payload FROM authority.fact WHERE fact_key='cancel' ORDER BY scope_id", []);
        expect(facts).toHaveLength(2);
        expect(facts[0]?.payload).toEqual(facts[1]?.payload);
      } finally { await composition.close(); }
    });
  });
}
