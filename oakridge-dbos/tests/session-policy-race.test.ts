import { expect, test } from "bun:test";
import type { CheckedValue } from "../src/core-client/generated-contracts";
import { commitDecision, type CommitRequest } from "../src/storage/commit";
import { prepareCommit } from "../src/storage/mutation-service";
import { readSnapshot } from "../src/storage/snapshot-reader";
import { setSessionPolicy } from "../src/storage/projects";
import type { ProjectId, RunId, ScopeId } from "../src/storage/schema-records";
import { unsealEffectPayload } from "../src/storage/effect-secret";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import type { EffectPayload } from "../src/effects/intents";
import { brief, developmentBundle, repository, runtimeFixture } from "./development-runtime-fixture";
import { withDatabase } from "./effect-fixture";

const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };

test.each(["policy-edit-then-pin", "pin-then-policy-edit"])("child-scope policy witness survives %s", async (order) => withDatabase(async ({ db }) => {
  const bundle = { key: "race", root: "root", limits: { max_depth: 64, max_list_items: 100 },
    schemas: [{ key: "unit", shape: { kind: "record", fields: [], dictionary: null } }],
    scopes: [{ key: "child", tree: { kind: "wait", reason: "race" }, commands: [], state_schema: "unit", outcome_schema: "unit", children: [], exports: [], resources: [], workers: [], pools: [], outputs: [] }] };
  const policy = (version: number) => ({ version, entries: [] });
  await db.query("INSERT INTO authority.project (id,name,repo_dir,session_policy) VALUES ('project','Race','/tmp',$1)", [JSON.stringify(policy(1))]);
  await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,$2)", [JSON.stringify(bundle), JSON.stringify({ digest: "digest", scopes: [{ key: "child", reads: [] }] })]);
  await db.query("INSERT INTO authority.run (id,definition_bundle_id,project_id) VALUES ('run','bundle','project')", []);
  await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('root','run','root',$1,$1)", [JSON.stringify(unit)]);
  await db.query("INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,input,local_state) VALUES ('child','run','root','child','cohort',$1,$1)", [JSON.stringify(unit)]);
  const source = (await readSnapshot(db, "child" as ScopeId, { id: "trigger", key: "start", payload: unit }))!;
  expect(source.read_set.policy).toEqual({ relation: "session_policy", id: "project", version: 1 });
  const request: CommitRequest = { identity: { run_id: "run" as RunId, scope_id: "child" as ScopeId, ingress_id: "pin", request_digest: "pin" },
    read_set: source.read_set, operator_version: null, outputs: [], capacity: [], effects: [],
    decision: { kind: "wait", reason: "race", continuations: [], explanation: { bundle_digest: "digest", node_id: "n", owner: "child", read_set: [], trace: [], trigger_id: "trigger" } } };
  if (order === "policy-edit-then-pin") {
    expect(await setSessionPolicy(db, "project" as ProjectId, policy(2))).toMatchObject({ ok: true });
    expect(await commitDecision(db, request, source)).toMatchObject({ ok: true, value: { kind: "Conflict", detail: expect.stringContaining("refresh decision") } });
  } else {
    expect(await commitDecision(db, request, source)).toMatchObject({ ok: true, value: { kind: "Committed" } });
    expect(await setSessionPolicy(db, "project" as ProjectId, policy(2))).toMatchObject({ ok: true });
  }
}));

test("policy edit waits for an in-flight child invocation pin", async () => withDatabase(async ({ db }) => {
  const bundle = await developmentBundle("implementation");
  const fixture = await runtimeFixture(db, bundle, { brief: { ...brief, cohort_id: "c02" }, repository, push_remote_owner: "owner" });
  try {
    const first = { version: 1, entries: [{ selector: { kind: "cohort" as const, stage_key: "implementation", cohort_key: "c02" },
      settings: { runtime: null, model: "gpt-6-sol", effort: "high" } }] };
    await db.query("INSERT INTO authority.project (id,name,repo_dir,session_policy) VALUES ('project','Overlapping pin','/tmp',$1)", [JSON.stringify(first)]);
    await db.query("UPDATE authority.run SET project_id='project' WHERE id=$1", [fixture.run_id]);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,collection_key,input,local_state) SELECT 'cohort',run_id,id,scope_key,'c02','cohorts',input,local_state FROM authority.scope_instance WHERE id=$1", [fixture.root_scope_id]);
    const scope_id = "cohort" as ScopeId;
    const trigger = { id: "begin-c02", key: "begin", payload: await fixture.checked("unit", {}) };
    const source = (await readSnapshot(db, scope_id, trigger))!;
    const evaluated = await fixture.core.request("evaluate", { bundle, snapshot: source.snapshot });
    if (!evaluated.ok || evaluated.value.kind !== "evaluated" || evaluated.value.value.kind !== "apply") throw new Error(JSON.stringify(evaluated));
    const prepared = prepareCommit({ run_id: fixture.run_id, scope_id, ingress_id: "pin", trigger, operator_version: null },
      { source, outcome: { ...evaluated.value.value, mutations: [] } });
    if (!prepared.ok) throw new Error(prepared.error.detail);
    let signal_pin: () => void = () => undefined;
    const pin_reached_write = new Promise<void>((resolve) => { signal_pin = resolve; });
    let release_pin: () => void = () => undefined;
    const hold_pin = new Promise<void>((resolve) => { release_pin = resolve; });
    const paused: TransactionalSqlExecutor = { query: db.query.bind(db), transaction: (operation, isolation) => db.transaction((tx) => operation({
      query: async (statement, parameters) => {
        if (statement.startsWith("INSERT INTO authority.effect_intent")) { signal_pin(); await hold_pin; }
        return tx.query(statement, parameters);
      },
    }), isolation) };
    const pin = commitDecision(paused, prepared.value, source);
    await pin_reached_write;
    let edit_finished = false;
    const edit = setSessionPolicy(db, "project" as ProjectId, { ...first, version: 2 }).then((result) => { edit_finished = true; return result; });
    try {
      await Bun.sleep(100);
      expect(edit_finished).toBe(false);
    } finally { release_pin(); }
    expect(await pin).toMatchObject({ ok: true, value: { kind: "Committed" } });
    expect(await edit).toMatchObject({ ok: true });
    const stored = (await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1", [scope_id]))[0]!;
    expect(unsealEffectPayload(stored.payload).invocation.session_settings?.policy_version).toBe(1);
  } finally { fixture.core.close(); }
}));

test("two invocation pins on sibling cohorts take the exclusive run lock without capacity changes", async () => withDatabase(async ({ db }) => {
  const bundle = await developmentBundle("implementation");
  const fixture = await runtimeFixture(db, bundle, { brief: { ...brief, cohort_id: "c02" }, repository, push_remote_owner: "owner" });
  try {
    for (const id of ["cohort-a", "cohort-b"]) await db.query(
      "INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,collection_key,input,local_state) SELECT $1,run_id,id,scope_key,$1,'cohorts',input,local_state FROM authority.scope_instance WHERE id=$2",
      [id, fixture.root_scope_id]);
    const prepared = await Promise.all(["cohort-a", "cohort-b"].map(async (id) => {
      const scope_id = id as ScopeId;
      const trigger = { id: `begin-${id}`, key: "begin", payload: await fixture.checked("unit", {}) };
      const source = (await readSnapshot(db, scope_id, trigger))!;
      const evaluated = await fixture.core.request("evaluate", { bundle, snapshot: source.snapshot });
      if (!evaluated.ok || evaluated.value.kind !== "evaluated" || evaluated.value.value.kind !== "apply") throw new Error(JSON.stringify(evaluated));
      expect(evaluated.value.value.invocations).toHaveLength(1);
      const request = prepareCommit({ run_id: fixture.run_id, scope_id, ingress_id: id, trigger, operator_version: null },
        { source, outcome: { ...evaluated.value.value, mutations: [] } });
      if (!request.ok) throw new Error(request.error.detail);
      expect(request.value.capacity).toHaveLength(0);
      return { source, request: request.value };
    }));
    let signal_first_write: () => void = () => undefined;
    const first_write = new Promise<void>((resolve) => { signal_first_write = resolve; });
    let release_first: () => void = () => undefined;
    const hold_first = new Promise<void>((resolve) => { release_first = resolve; });
    const paused: TransactionalSqlExecutor = { query: db.query.bind(db), transaction: (operation, isolation) => db.transaction((tx) => operation({
      query: async (statement, parameters) => {
        if (statement.startsWith("INSERT INTO authority.effect_intent")) { signal_first_write(); await hold_first; }
        return tx.query(statement, parameters);
      },
    }), isolation) };
    const first = commitDecision(paused, prepared[0]!.request, prepared[0]!.source);
    await first_write;
    let signal_second_lock: () => void = () => undefined;
    const second_lock = new Promise<void>((resolve) => { signal_second_lock = resolve; });
    let signal_second_acquired: () => void = () => undefined;
    const second_acquired = new Promise<void>((resolve) => { signal_second_acquired = resolve; });
    const observed: TransactionalSqlExecutor = { query: db.query.bind(db), transaction: (operation, isolation) => db.transaction((tx) => operation({
      query: async <Row extends object>(statement: string, parameters: readonly unknown[]): Promise<readonly Row[]> => {
        if (statement.startsWith("SELECT pg_advisory_xact_lock")) {
          signal_second_lock();
          const result = await tx.query<Row>(statement, parameters);
          signal_second_acquired();
          return result;
        }
        return tx.query(statement, parameters);
      },
    }), isolation) };
    const second = commitDecision(observed, prepared[1]!.request, prepared[1]!.source);
    await second_lock;
    let acquired_while_first_open: boolean;
    try {
      acquired_while_first_open = await Promise.race([second_acquired.then(() => true), Bun.sleep(200).then(() => false)]);
    } finally { release_first(); }
    const results = await Promise.all([first, second]);
    expect(acquired_while_first_open).toBe(false);
    for (const result of results) expect(result).toMatchObject({ ok: true, value: { kind: "Committed" } });
  } finally { fixture.core.close(); }
}));

test("busy sibling cohorts do not exhaust the policy edit or decision retry budget", async () => withDatabase(async ({ db }) => {
  const bundle = await developmentBundle("implementation");
  const fixture = await runtimeFixture(db, bundle, { brief: { ...brief, cohort_id: "c02" }, repository, push_remote_owner: "owner" });
  try {
    await db.query("INSERT INTO authority.project (id,name,repo_dir,session_policy) VALUES ('project','Busy run','/tmp',$1)", [JSON.stringify({ version: 1, entries: [] })]);
    await db.query("UPDATE authority.run SET project_id='project' WHERE id=$1", [fixture.run_id]);
    for (const id of ["cohort-a", "cohort-b"]) await db.query(
      "INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,collection_key,input,local_state) SELECT $1,run_id,id,scope_key,$1,'cohorts',input,local_state FROM authority.scope_instance WHERE id=$2",
      [id, fixture.root_scope_id]);
    const trigger = { id: "auth", key: "auth", payload: await fixture.checked("text", "ok") };
    const transitions = await Promise.all(["cohort-a", "cohort-b"].map(async (id) => {
      const scope_id = id as ScopeId;
      const source = (await readSnapshot(db, scope_id, trigger))!;
      const evaluated = await fixture.core.request("evaluate", { bundle, snapshot: source.snapshot });
      if (!evaluated.ok || evaluated.value.kind !== "evaluated") throw new Error(JSON.stringify(evaluated));
      return { run_id: fixture.run_id, scope_id, ingress_id: id, trigger, operator_version: null,
        prepared: { request_digest: id, decision: { source, outcome: evaluated.value.value } } };
    }));
    const [left, right, edit] = await Promise.all([
      fixture.mutations.decide(transitions[0]!), fixture.mutations.decide(transitions[1]!),
      fixture.mutations.setSessionPolicy("project" as ProjectId, { version: 2, entries: [] }),
    ]);
    expect(left).toMatchObject({ ok: true, value: { kind: "Committed" } });
    expect(right).toMatchObject({ ok: true, value: { kind: "Committed" } });
    expect(edit).toMatchObject({ ok: true });
  } finally { fixture.core.close(); }
}));

test.each(["policy-edit-then-pin", "pin-then-policy-edit"])("implementation cohort pin and policy edit commit consistently in %s order", async (order) => withDatabase(async ({ db }) => {
  const bundle = await developmentBundle("implementation");
  const fixture = await runtimeFixture(db, bundle, { brief: { ...brief, cohort_id: "c02" }, repository, push_remote_owner: "owner" });
  try {
    const policy = (version: number, model: string, effort: string) => ({ version, entries: [{ selector: { kind: "cohort" as const, stage_key: "implementation", cohort_key: "c02" },
      settings: { runtime: null, model, effort } }] });
    await db.query("INSERT INTO authority.project (id,name,repo_dir,session_policy) VALUES ('project','Pin race','/tmp',$1)", [JSON.stringify(policy(1, "gpt-6-sol", "high"))]);
    await db.query("UPDATE authority.run SET project_id='project' WHERE id=$1", [fixture.run_id]);
    await db.query("INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,collection_key,input,local_state) SELECT 'cohort',run_id,id,scope_key,'c02','cohorts',input,local_state FROM authority.scope_instance WHERE id=$1", [fixture.root_scope_id]);
    const scope_id = "cohort" as ScopeId;
    const trigger = { id: "begin-c02", key: "begin", payload: await fixture.checked("unit", {}) };
    const source = (await readSnapshot(db, scope_id, trigger))!;
    const evaluated = await fixture.core.request("evaluate", { bundle, snapshot: source.snapshot });
    if (!evaluated.ok || evaluated.value.kind !== "evaluated" || evaluated.value.value.kind !== "apply") throw new Error(JSON.stringify(evaluated));
    expect(evaluated.value.value.invocations).toHaveLength(1);
    // Leave capacity untouched so the run lock's mode depends on the invocation.
    const outcome = { ...evaluated.value.value, mutations: [] };
    const input = { run_id: fixture.run_id, scope_id, ingress_id: "pin-c02", trigger, operator_version: null };
    const prepared = prepareCommit(input, { source, outcome });
    if (!prepared.ok) throw new Error(prepared.error.detail);
    const edit = () => setSessionPolicy(db, "project" as ProjectId, policy(2, "gpt-6-luna", "low"));
    const commitWithoutProviderIo = async (request: CommitRequest, snapshot: typeof source) => {
      const prior_fetch = globalThis.fetch;
      globalThis.fetch = (async () => { throw new Error("provider IO occurred before the pin commit returned"); }) as unknown as typeof fetch;
      try { return await commitDecision(db, request, snapshot); }
      finally { globalThis.fetch = prior_fetch; }
    };
    if (order === "policy-edit-then-pin") {
      expect(await edit()).toMatchObject({ ok: true });
      expect(await commitWithoutProviderIo(prepared.value, source)).toMatchObject({ ok: true, value: { kind: "Conflict", detail: expect.stringContaining("refresh decision") } });
      const refreshed = (await readSnapshot(db, scope_id, trigger))!;
      const retry = prepareCommit(input, { source: refreshed, outcome });
      if (!retry.ok) throw new Error(retry.error.detail);
      expect(await commitWithoutProviderIo(retry.value, refreshed)).toMatchObject({ ok: true, value: { kind: "Committed" } });
    } else {
      expect(await commitWithoutProviderIo(prepared.value, source)).toMatchObject({ ok: true, value: { kind: "Committed" } });
      expect(await edit()).toMatchObject({ ok: true });
    }
    const stored = (await db.query<{ payload: EffectPayload }>("SELECT payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [scope_id]))[0];
    expect(stored).toBeDefined();
    const pinned = unsealEffectPayload(stored!.payload).invocation;
    const expected = order === "policy-edit-then-pin" ? { policy_version: 2, model: "gpt-6-luna", effort: "low" } : { policy_version: 1, model: "gpt-6-sol", effort: "high" };
    expect(pinned.session_settings).toMatchObject(expected);
    expect(JSON.parse(pinned.bytes)).toMatchObject({ model: expected.model, effort: expected.effort });
  } finally { fixture.core.close(); }
}));
