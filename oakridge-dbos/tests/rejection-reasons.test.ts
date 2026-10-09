import { expect, test } from "bun:test";
import { Hono } from "hono";
import { resolve } from "node:path";
import { deliverEvidence } from "../src/effects/evidence";
import type { EffectIntent } from "../src/effects/intents";
import { installDefinitionApi } from "../src/http/app";
import { submitScopeCommand } from "../src/http/scope-commands";
import type { CoreClient } from "../src/core-client/client";
import type { MutationService } from "../src/storage/mutation-service";
import { commitDecision, type CommitRequest } from "../src/storage/commit";
import { requestDigest } from "../src/storage/receipts";
import { readSnapshot } from "../src/storage/snapshot-reader";
import { validateDecision } from "../src/storage/storage-validator";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import type { CommitRejectionReason } from "../src/storage/commit";
import type { RunId, ScopeId } from "../src/storage/schema-records";
import { withDatabase, unit } from "./effect-fixture";
import { brief, build_body, developmentBundle, repository, runtimeFixture } from "./development-runtime-fixture";

const rejectionDetailMatch = /\b(?:outcome|rejection|commit_result|result\.value)\.detail\s*(?:===|!==|==|!=|\.startsWith\s*\(|\.includes\s*\()/;

test("commit rejection control flow never compares human detail text", async () => {
  const root = resolve(import.meta.dir, "../src");
  const violations: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
    const source = await Bun.file(resolve(root, path)).text();
    if (rejectionDetailMatch.test(source) || source.includes("BENIGN_REJECTIONS")) violations.push(path);
  }
  expect(violations).toEqual([]);
});

test("the rejection detail guard catches equality and prefix branching", () => {
  expect([
    'outcome.detail === "terminal"',
    'rejection.detail.startsWith("capacity/")',
  ].every((source) => rejectionDetailMatch.test(source))).toBe(true);
});

test("evidence delivery treats the reason as authoritative when detail text changes", async () => {
  const db = { query: async () => [{ run_id: "run" }], transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ query: async () => [] }) } as unknown as TransactionalSqlExecutor;
  const intent = { id: "effect", scope_id: "scope" as import("../src/storage/schema-records").ScopeId,
    execution_id: null, payload: { evidence: { id: "evidence", key: "failure",
      payload: { schema: "unit", data: { kind: "record" as const, fields: [], dictionary: [] } } } } } as unknown as Pick<EffectIntent, "id" | "scope_id" | "execution_id" | "payload">;
  const deliver = (reason: CommitRejectionReason, detail: string) => deliverEvidence(db,
    { decide: async () => ({ ok: true, value: { kind: "Rejected", reason, detail } }) } as unknown as MutationService, intent);
  expect(await deliver("owner_terminal", "the wording changed")).toEqual({ kind: "delivered" });
  expect(await deliver("invalid", "owner is terminal")).toEqual({ kind: "deferred", detail: "owner is terminal" });
});

test("evidence delivery accepts a decision the evaluator rejected as settled, not a reason to retry", async () => {
  const db = { query: async () => [{ run_id: "run" }], transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ query: async () => [] }) } as unknown as TransactionalSqlExecutor;
  const intent = { id: "effect", scope_id: "scope" as import("../src/storage/schema-records").ScopeId,
    execution_id: null, payload: { evidence: { id: "evidence", key: "failure",
      payload: { schema: "unit", data: { kind: "record" as const, fields: [], dictionary: [] } } } } } as unknown as Pick<EffectIntent, "id" | "scope_id" | "execution_id" | "payload">;
  const mutations = { decide: async () => ({ ok: true, value: { kind: "DecisionRejected", error: "invalid_command", detail: unit } }) } as unknown as MutationService;
  expect(await deliverEvidence(db, mutations, intent)).toEqual({ kind: "delivered" });
});

test("validateDecision refuses a reject that arrives with outputs, capacity changes, effects or child cancellations", async () => withDatabase(async ({ db }) => {
  await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,$2)",
    [JSON.stringify({ limits: { max_depth: 64, max_list_items: 100 }, schemas: [{ key: "unit", shape: { kind: "record", fields: [], dictionary: null } }],
      scopes: [{ key: "root", tree: { kind: "wait", reason: "storage fixture" }, commands: [], state_schema: "unit", outcome_schema: "unit",
        children: [], exports: [], resources: [], workers: [], pools: [], outputs: [{ key: "out", schema: "unit", producers: [], publication_trigger: "start" }] }] }),
    JSON.stringify({ digest: "digest", scopes: [{ key: "root", reads: [] }] })]);
  await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
  await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','root',$1,$1)", [JSON.stringify(unit)]);
  const trigger = { id: "t", key: "start", payload: unit };
  const source = (await readSnapshot(db, "scope" as ScopeId, trigger))!;
  const decision = { kind: "reject" as const, error: "invalid_command", detail: unit,
    explanation: { bundle_digest: "digest", node_id: "n", owner: "scope", read_set: [], trace: [], trigger_id: "t" } };
  const base: CommitRequest = { identity: { run_id: "run" as RunId, scope_id: "scope" as ScopeId, ingress_id: "i", request_digest: "digest" },
    read_set: source.read_set, operator_version: null, decision, outputs: [], capacity: [], effects: [] };
  expect(validateDecision(base, source)).toMatchObject({ ok: true });
  const with_outputs: CommitRequest = { ...base, outputs: [{ scope_id: "scope" as ScopeId, output_key: "out", collection_key: "",
    body: unit, predecessor_id: null, expected_slot_version: null, execution_id: null }] };
  expect(validateDecision(with_outputs, source)).toMatchObject({ ok: false, error: { detail: "a rejected decision must not carry outputs, capacity changes, effects or child cancellations" } });
  const with_capacity: CommitRequest = { ...base, capacity: [{ kind: "acquire", pool_id: "pool" as import("../src/storage/schema-records").PoolId, scope_id: "scope" as ScopeId }] };
  expect(validateDecision(with_capacity, source)).toMatchObject({ ok: false, error: { detail: "a rejected decision must not carry outputs, capacity changes, effects or child cancellations" } });
  const with_effects: CommitRequest = { ...base, effects: [{ effect_key: "e", payload: unit, execution_id: null }] };
  expect(validateDecision(with_effects, source)).toMatchObject({ ok: false, error: { detail: "a rejected decision must not carry outputs, capacity changes, effects or child cancellations" } });
  const with_child_cancellations: CommitRequest = { ...base, child_cancellations: [{ source, request: base }] };
  expect(validateDecision(with_child_cancellations, source)).toMatchObject({ ok: false, error: { detail: "a rejected decision must not carry outputs, capacity changes, effects or child cancellations" } });
}));

test("a rejected decision writes only its ingress receipt, and its replay answers the same rejection without rewriting it", async () => withDatabase(async ({ db }) => {
  await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,$2)",
    [JSON.stringify({ limits: { max_depth: 64, max_list_items: 100 }, schemas: [{ key: "unit", shape: { kind: "record", fields: [], dictionary: null } }],
      scopes: [{ key: "root", tree: { kind: "wait", reason: "storage fixture" }, commands: [], state_schema: "unit", outcome_schema: "unit",
        children: [], exports: [], resources: [], workers: [], pools: [], outputs: [] }] }),
    JSON.stringify({ digest: "digest", scopes: [{ key: "root", reads: [] }] })]);
  await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
  await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','root',$1,$1)", [JSON.stringify(unit)]);
  const trigger = { id: "t", key: "start", payload: unit };
  const source = (await readSnapshot(db, "scope" as ScopeId, trigger))!;
  const request: CommitRequest = {
    identity: { run_id: "run" as RunId, scope_id: "scope" as ScopeId, ingress_id: "i", request_digest: "digest" },
    read_set: source.read_set, operator_version: null,
    decision: { kind: "reject", error: "invalid_command", detail: unit,
      explanation: { bundle_digest: "digest", node_id: "n", owner: "scope", read_set: [], trace: [], trigger_id: "t" } },
    outputs: [], capacity: [], effects: [],
  };
  const first = await commitDecision(db, request, source);
  expect(first).toMatchObject({ ok: true, value: { kind: "DecisionRejected", error: "invalid_command", detail: unit } });
  const replay = await commitDecision(db, request, source);
  expect(replay).toEqual(first);
  const counts = await db.query<{ relation: string; count: string }>(
    `SELECT relation, count FROM (
       SELECT 'ingress_receipt' AS relation, count(*)::text AS count FROM authority.ingress_receipt
       UNION ALL SELECT 'artifact_revision', count(*)::text FROM authority.artifact_revision
       UNION ALL SELECT 'capacity_reservation', count(*)::text FROM authority.capacity_reservation
       UNION ALL SELECT 'effect_intent', count(*)::text FROM authority.effect_intent
       UNION ALL SELECT 'fact', count(*)::text FROM authority.fact
       UNION ALL SELECT 'transition', count(*)::text FROM authority.transition
     ) totals`, []);
  expect(Object.fromEntries(counts.map((row) => [row.relation, row.count]))).toEqual(
    { ingress_receipt: "1", artifact_revision: "0", capacity_reservation: "0", effect_intent: "0", fact: "0", transition: "0" });
}));

test("a publication the evaluator rejects answers 422 with the decision_rejected shape", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    await f.fact("begin");
    const execution_id = await f.selected("build");
    const rejecting: MutationService = { ...f.mutations, decide: async () => ({ ok: true,
      value: { kind: "DecisionRejected", error: "invalid_command", detail: unit } }) };
    const app = new Hono();
    installDefinitionApi(app, { db, core: f.core, mutations: rejecting, wake: async () => {} });
    const response = await app.request(`http://localhost/api/runs/${f.run_id}/scopes/${f.root_scope_id}/executions/${execution_id}/outputs/build_result`, {
      method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${await f.publicationSecret(execution_id)}` },
      body: JSON.stringify({ request_id: "rejected-publish", predecessor_id: null, collection_key: "", body: build_body }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ kind: "decision_rejected", error: "invalid_command", detail: unit });
  } finally { f.core.close(); }
}));

test("evidence the evaluator rejects answers 422 with the decision_rejected shape", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    await f.fact("begin");
    const execution_id = await f.selected("build");
    const rejecting: MutationService = { ...f.mutations, decide: async () => ({ ok: true,
      value: { kind: "DecisionRejected", error: "invalid_command", detail: unit } }) };
    const app = new Hono();
    installDefinitionApi(app, { db, core: f.core, mutations: rejecting, wake: async () => {} });
    const response = await app.request(`http://localhost/api/runs/${f.run_id}/scopes/${f.root_scope_id}/executions/${execution_id}/facts/build_submitted`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await f.publicationSecret(execution_id)}` },
      body: JSON.stringify({ request_id: "rejected-evidence", payload: {} }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ kind: "decision_rejected", error: "invalid_command", detail: unit });
  } finally { f.core.close(); }
}));

test("a scope command replaying a stored rejection answers the same decision_rejected shape as the fresh result, not a 500", async () => {
  const request = { command_key: "k", payload: {}, request_id: "r", scope_id: "scope" as ScopeId, expected_scope_version: 0, targets: [] };
  const digest = requestDigest(request);
  const receipt = { kind: "rejected", error: "invalid_command", detail: unit };
  const db = { query: async (sql: string) => sql.includes("authority.ingress_receipt")
    ? [{ run_id: "run", scope_id: "scope", ingress_id: "r", request_digest: digest, result: receipt }] : [] } as unknown as TransactionalSqlExecutor;
  const result = await submitScopeCommand({ db, core: {} as CoreClient, mutations: {} as MutationService }, "run" as RunId, request);
  expect(result).toMatchObject({ ok: false, error: { kind: "decision_rejected", error: "invalid_command", detail: unit } });
});
