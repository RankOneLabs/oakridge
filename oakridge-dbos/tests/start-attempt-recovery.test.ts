import { expect, test } from "bun:test";
import type { CoreClient } from "../src/core-client/client";
import type { Invocation } from "../src/core-client/generated-contracts";
import { pendingCleanupCount, type EffectPayload } from "../src/effects/intents";
import { selectedInvocation, type EffectProvider, type InvocationId } from "../src/effects/provider";
import { persistEffectResult } from "../src/storage/effect-results";
import { sealEffectPayload } from "../src/storage/effect-secret";
import { createMutationService } from "../src/storage/mutation-service";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { DEFAULT_WORKFLOW_TIMING, performStartAttempt, registerWorkflowServices } from "../src/workflows/topology";
import { withDatabase } from "./effect-fixture";

const selection = { definition: { operation: "run", contract_version: 1, deadline_ms: 1000, input_schema: "input",
  max_attempts: 2, outputs: [], settings: [], tools: [] }, input: { schema: "input", data: { kind: "string", value: "pinned" } },
  selection: { worker: "agent", action: "build" } } satisfies Invocation;
const start: EffectPayload = { action: "start", handle: null,
  invocation: selectedInvocation("invocation" as InvocationId, "execution", selection, null) };
process.env.OAKRIDGE_EFFECT_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString("base64url");
async function prepare(db: TransactionalSqlExecutor, payload: EffectPayload, provider: EffectProvider): Promise<void> {
  await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest','{}','{}')", []);
  await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
  await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('scope','run','scope','{}','{}')", []);
  await db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status) VALUES ('execution','scope','agent',1,'pending')", []);
  await db.query("INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload) VALUES ('start','scope','execution','ingress:0',$1)", [JSON.stringify(sealEffectPayload(payload))]);
  const core = { request: async () => { throw new Error("unexpected core IO in provider-start test"); } } as unknown as CoreClient;
  registerWorkflowServices({ db, core, mutations: createMutationService(db, core), provider, timing: DEFAULT_WORKFLOW_TIMING });
}
const idle: Omit<EffectProvider, "start"> = {
  observe: async () => ({ kind: "acknowledged", value: { kind: "running" } }),
  stop: async () => ({ kind: "acknowledged", value: { stopped: true } }),
};

test("a lost uncertain result still owes cleanup after a definite final failure", async () => withDatabase(async ({ db }) => {
  let calls = 0;
  await prepare(db, start, { ...idle, start: async () => ++calls === 1
    ? { kind: "uncertain", detail: "lost reply" } : { kind: "transiently_unavailable", detail: "busy" } });
  await performStartAttempt("start"); // Outcome is lost when persistence fails; restart from the authority row.
  const final = await performStartAttempt("start");
  if (!final || final.kind !== "rejected") throw new Error("final attempt must reject");
  await persistEffectResult(db, { intent_id: "start", status: "rejected", payload: final.payload, terminal_result: null });
  const stops = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.effect_intent WHERE payload->>'action'='stop'", []);
  expect({ calls, uncertain: final.payload.has_uncertain_start, unfinished: final.payload.start_in_flight,
    cleanup: await pendingCleanupCount(db, "run"), stops: stops[0]?.count })
    .toEqual({ calls: 2, uncertain: true, unfinished: false, cleanup: 1, stops: "1" });
}));

test("re-executing the start step after losing its checkpoint cannot repeat IO beyond a one-attempt limit", async () => withDatabase(async ({ db }) => {
  const payload = { ...start, invocation: { ...start.invocation, selection: {
    ...selection, definition: { ...selection.definition, max_attempts: 1 },
  } } };
  let calls = 0;
  await prepare(db, payload, { ...idle, start: async () => { calls++; return { kind: "acknowledged", value: { kind: "kbbl_session", session_id: "session" } }; } });
  await performStartAttempt("start"); // IO completed, but the DBOS step result was not checkpointed.
  const recovered = await performStartAttempt("start");
  if (!recovered || recovered.kind !== "rejected") throw new Error("recovery must reject the exhausted reservation");
  const repeated = await performStartAttempt("start"); // Another lost checkpoint still cannot issue IO.
  expect({ calls, kind: repeated?.kind, uncertain: recovered.payload.has_uncertain_start,
    attempts: recovered.payload.start_attempts }).toEqual({ calls: 1, kind: "rejected", uncertain: true, attempts: 1 });
  await persistEffectResult(db, { intent_id: "start", status: "rejected", payload: recovered.payload, terminal_result: null });
  expect(await pendingCleanupCount(db, "run")).toBe(1);
}));

test.each([2147483648, 4294967295])("the full u32 attempt limit %s can be reserved and exhausted", async (limit) => withDatabase(async ({ db }) => {
  const payload = { ...start, start_attempts: limit - 1, start_in_flight: false, invocation: { ...start.invocation, selection: {
    ...selection, definition: { ...selection.definition, max_attempts: limit },
  } } };
  let calls = 0;
  await prepare(db, payload, { ...idle, start: async () => { calls++; return { kind: "transiently_unavailable", detail: "busy" }; } });
  const outcome = await performStartAttempt("start");
  if (!outcome || outcome.kind !== "rejected") throw new Error("the final allowed failure must reject");
  await persistEffectResult(db, { intent_id: "start", status: "rejected", payload: outcome.payload, terminal_result: null });
  await performStartAttempt("start");
  expect({ calls, attempts: outcome.payload.start_attempts, uncertain: outcome.payload.has_uncertain_start })
    .toEqual({ calls: 1, attempts: limit, uncertain: false });
}));

test("persisted definite failures settle reservations without creating cleanup obligations", async () => withDatabase(async ({ db }) => {
  let calls = 0;
  await prepare(db, start, { ...idle, start: async () => { calls++; return { kind: "transiently_unavailable", detail: "busy" }; } });
  const first = await performStartAttempt("start");
  if (!first || first.kind !== "retry") throw new Error("first failure must retry");
  await persistEffectResult(db, { intent_id: "start", status: "pending", payload: first.payload, terminal_result: null });
  const final = await performStartAttempt("start");
  if (!final || final.kind !== "rejected") throw new Error("final failure must reject");
  await persistEffectResult(db, { intent_id: "start", status: "rejected", payload: final.payload, terminal_result: null });
  const stops = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.effect_intent WHERE payload->>'action'='stop'", []);
  expect({ calls, cleanup: await pendingCleanupCount(db, "run"), stops: stops[0]?.count })
    .toEqual({ calls: 2, cleanup: 0, stops: "0" });
}));

test("start retry replays pinned settings after the project policy changes", async () => withDatabase(async ({ db }) => {
  const settings = { runtime: "codex" as const, model: "gpt-6-sol", effort: "high", policy_version: 1 };
  const invocation = selectedInvocation("pinned" as InvocationId, "execution", selection, settings);
  const payload: EffectPayload = { action: "start", handle: null, invocation };
  const seen: string[] = [];
  await prepare(db, payload, { ...idle, start: async (selected) => {
    seen.push(selected.bytes);
    return seen.length === 1 ? { kind: "transiently_unavailable", detail: "busy" }
      : { kind: "acknowledged", value: { kind: "kbbl_session", session_id: "session" } };
  } });
  await db.query("INSERT INTO authority.project (id,name,repo_dir,session_policy) VALUES ('project','Replay','/tmp',$1)",
    [JSON.stringify({ version: 1, entries: [] })]);
  await db.query("UPDATE authority.run SET project_id='project' WHERE id='run'", []);
  const first = await performStartAttempt("start");
  if (!first || first.kind !== "retry") throw new Error("first start must be retryable");
  await persistEffectResult(db, { intent_id: "start", status: "pending", payload: first.payload, terminal_result: null });
  await db.query("UPDATE authority.project SET session_policy=$1 WHERE id='project'", [JSON.stringify({ version: 2, entries: [] })]);
  const second = await performStartAttempt("start");
  expect(second?.kind).toBe("acknowledged");
  expect(seen).toEqual([invocation.bytes, invocation.bytes]);
  expect(JSON.parse(seen[1]!).session_settings).toEqual(settings);
}));
