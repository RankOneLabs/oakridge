import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import type { CheckedValue, DefinitionBundle, Invocation } from "../src/core-client/generated-contracts";
import { deletionEligibility, pendingCleanupCount, requiresCleanup, type EffectPayload } from "../src/effects/intents";
import { selectedInvocation, type InvocationId } from "../src/effects/provider";
import { cancelRun, createMutationService, deleteRun } from "../src/storage/mutation-service";
import type { ScopeId } from "../src/storage/schema-records";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { unit, withDatabase } from "./effect-fixture";

const selection = { definition: { operation: "run", provider: "kbbl", contract_version: 1, deadline_ms: 1000, input_schema: "input",
  max_attempts: 1, outputs: [], settings: [], tools: [] }, input: { schema: "input", data: { kind: "string", value: "pinned" } },
  selection: { worker: "agent", action: "build" } } satisfies Invocation;
const start: EffectPayload = { action: "start", handle: null, invocation: selectedInvocation("invocation-1" as InvocationId, "execution-1", selection) };

test("cleanup is owed exactly when an external execution may exist", () => {
  expect(requiresCleanup({ status: "pending", payload: start })).toBe(false);
  expect(requiresCleanup({ status: "pending", payload: { ...start, has_dispatched: true } })).toBe(true);
  expect(requiresCleanup({ status: "rejected", payload: { ...start, has_dispatched: true } })).toBe(false);
  expect(requiresCleanup({ status: "rejected", payload: { ...start, has_dispatched: true, has_uncertain_start: true } })).toBe(true);
  expect(requiresCleanup({ status: "acknowledged", payload: { ...start, handle: { kind: "kbbl_session", session_id: "s" } } })).toBe(true);
  expect(requiresCleanup({ status: "revoked", payload: { ...start, handle: { kind: "kbbl_session", session_id: "s" } } })).toBe(true);
  expect(requiresCleanup({ status: "cleanup_confirmed", payload: { ...start, handle: { kind: "kbbl_session", session_id: "s" } } })).toBe(false);
  expect(requiresCleanup({ status: "acknowledged", payload: { ...start, handle: { kind: "completed", result: unit } } })).toBe(false);
});

test("cancelling an uncertain start retains its identity in a stop intent", async () => {
  const inserted: Array<readonly unknown[]> = [];
  const db = {
    transaction: async <Value>(operation: (tx: TransactionalSqlExecutor) => Promise<Value>) => operation(db as TransactionalSqlExecutor),
    query: async (sql: string, parameters: readonly unknown[]) => {
      if (sql.includes("SELECT id FROM authority.run")) return [{ id: "run" }];
      if (sql.includes("FROM authority.effect_intent i") && sql.includes("FOR UPDATE OF i"))
        return [{ id: "start", scope_id: "scope", execution_id: "execution-1", effect_key: "start", payload: { ...start, has_dispatched: true, has_uncertain_start: true }, status: "pending", version: 1 }];
      if (sql.includes("INSERT INTO authority.effect_intent")) { inserted.push(parameters); return [{ id: parameters[0] }]; }
      return [];
    },
  } as unknown as TransactionalSqlExecutor;
  expect(await cancelRun(db, { kind: "cancel_run", run_id: "run", reason: "operator" })).toEqual({ kind: "cancelled", stop_intents: 1 });
  const stop = JSON.parse(String(inserted[0]?.[4])) as EffectPayload;
  expect(stop.invocation.id).toBe(start.invocation.id);
  expect(stop.handle).toBeNull();
});

test("deletion is refused while an external cleanup obligation remains", async () => {
  const db = { query: async (sql: string) => sql.includes("count(*)") ? [{ count: "1" }] : [] } as unknown as TransactionalSqlExecutor;
  expect(await deletionEligibility(db, "run")).toEqual({ kind: "refused", obligations: 1 });
});

test("selected invocation survives cancellation and blocks deletion until stop is acknowledged", async () => withDatabase(async ({ db }) => {
  await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
  await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
  await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','scope','{}','{}')", []);
  await db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ('execution-1','scope','agent',1,'pending')", []);
  await db.query("INSERT INTO authority.execution_selection (id,scope_id,worker_key,execution_id,generation) VALUES ('selection','scope','agent','execution-1',1)", []);
  await db.query("INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload) VALUES ('start','scope','execution-1','ingress:0',$1)", [JSON.stringify(start)]);
  expect(await pendingCleanupCount(db, "run")).toBe(0);
  await db.query("UPDATE authority.effect_intent SET payload=payload||'{\"has_dispatched\":true,\"has_uncertain_start\":true}' WHERE id='start'", []);
  expect(await pendingCleanupCount(db, "run")).toBe(1);
  expect(await cancelRun(db, { kind: "cancel_run", run_id: "run", reason: "operator" })).toEqual({ kind: "cancelled", stop_intents: 1 });
  const stops = await db.query<{ payload: EffectPayload; status: string }>("SELECT payload,status FROM authority.effect_intent WHERE effect_key='ingress:0:stop'", []);
  expect(stops[0]).toMatchObject({ status: "cleanup_pending", payload: { action: "stop", invocation: { id: "invocation-1" } } });
  expect(await deleteRun(db, "run")).toEqual({ kind: "refused", obligations: 1 });
  await db.query("UPDATE authority.effect_intent SET status='cleanup_confirmed' WHERE effect_key='ingress:0:stop'", []);
  expect(await deleteRun(db, "run")).toEqual({ kind: "deleted" });
}));

test("run cancellation evaluates each scope's declared cancellation policy and retains one stop identity", async () => withDatabase(async ({ db }) => {
  const started = CoreClient.start({ binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), deadlineMs: 1000 });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const core = started.value;
  try {
    const original: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/children-1.json")).json();
    const child = original.scopes[1]!;
    if (child.tree.kind !== "match") throw new Error("child fixture must dispatch triggers");
    const bundle = { ...original, scopes: [original.scopes[0]!, { ...child, cancellation: { trigger: "halt_child" },
      commands: child.commands.map((command) => command.key === "cancel" ? { ...command, key: "halt_child" } : command),
      tree: { ...child.tree, cases: child.tree.cases.map((item) => item.variant === "cancel" ? { variant: "halt_child", node: { kind: "apply" as const, id: "child-policy", actions: [], mutations: [{ kind: "revoke" as const, worker: "author" }, { kind: "stop" as const, worker: "author" }], outcome: { kind: "literal" as const, schema: "result", value: { kind: "released", value: {} } } } } : item.variant === "publish" && item.node.kind === "apply" ? { ...item, node: { ...item.node, outcome: { kind: "literal" as const, schema: "result", value: { kind: "withdrawn", value: {} } } } } : item),
        otherwise: { kind: "wait" as const, id: "child-wait", continuations: ["publish", "halt_child"], reason: "waiting", attention: { label: "Waiting", trigger: "publish" } } } }] };
    const mutations = createMutationService(db, core);
    const run = await mutations.startRun({ bundle, available_operations: bundle.operations, input: {} });
    if (!run.ok) throw new Error(JSON.stringify(run.error));
    const input = { run_id: run.value.run_id, scope_id: run.value.root_scope_id, ingress_id: "begin", trigger: { id: "begin", key: "begin", payload: unit }, operator_version: null };
    expect(await mutations.decide(input)).toMatchObject({ ok: true, value: { kind: "Committed" } });
    const scopes = await db.query<{ id: ScopeId }>("SELECT id FROM authority.scope_instance WHERE parent_id=$1", [run.value.root_scope_id]);
    expect(await mutations.decide({ ...input, scope_id: scopes[0]!.id })).toMatchObject({ ok: true, value: { kind: "Committed" } });
    await db.query("UPDATE authority.effect_intent SET payload=payload||'{\"has_dispatched\":true,\"has_uncertain_start\":true}' WHERE payload->>'action'='start'", []);
    expect(await cancelRun(db, { kind: "cancel_run", run_id: run.value.run_id, reason: "operator" }, core)).toMatchObject({ kind: "cancelled", stop_intents: 1 });
    const outcomes = await db.query<{ scope_key: string; outcome: CheckedValue }>("SELECT scope_key,outcome FROM authority.scope_instance ORDER BY scope_key", []);
    expect(outcomes.map((scope) => [scope.scope_key, scope.outcome.data.kind === "variant" ? scope.outcome.data.variant : null])).toEqual([["batch", "withdrawn"], ["document", "released"]]);
    await cancelRun(db, { kind: "cancel_run", run_id: run.value.run_id, reason: "operator" }, core);
    expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.effect_intent WHERE payload->>'action'='stop'", []))[0]?.count).toBe("1");
    expect(await deleteRun(db, run.value.run_id)).toMatchObject({ kind: "refused" });
  } finally { core.close(); }
}));
