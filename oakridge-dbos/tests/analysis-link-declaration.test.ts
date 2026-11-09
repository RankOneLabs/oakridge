import { commitTestDefinition } from "./committed-fixture";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { sql } from "kysely";
import { createApp } from "../../observation/src/http/app";
import { oakridgeProfile } from "../../observation/src/producers/oakridge/profile";
import { openDatabase as openObservationDatabase, withTenant, type Database as ObservationDatabase } from "../../observation/src/storage/database";
import { migrateEmptyDatabase as migrateObservation } from "../../observation/src/storage/migrate";
import { readRelationDeclarations } from "../../observation/src/storage/capture-store";
import { logicalItemId } from "../../observation/src/projection/relations";
import { publishObservationOnce, startObservationPublisher, type ObservationOptions } from "../src/adapters/observation";
import { ANALYSIS_LINKS_DECLARED, selectApplicableEntries, selectDeclarationRefusal, type AnalysisLinkDeclaration, type DeclarationAuthority } from "../src/domain/analysis-link-declaration";
import type { RunId } from "../src/domain/primitives";
import { createHttpApp } from "../src/http/app";
import { browserWritePolicy } from "../src/http/browser-write-policy";
import { commitAnalysisLinkDeclaration, commitEvent } from "../src/storage/commit";
import { openDatabase, type Database } from "../src/storage/database";
import { listLiveRuns, readCommittedEventsAfter, readRunInspect } from "../src/storage/read-store";
import { actionOf, ANALYSIS_LINK_WORKFLOW, executor, launch, openAuthority, scratchDatabase, submitter, unitOf, OPERATOR, type Authority } from "./authority-fixture";

const DELIVERY_WAIT_MS = 60_000;
let authority: Authority;
let definition_id: Awaited<ReturnType<typeof commitTestDefinition>>["definition_id"];
beforeAll(async () => {
  authority = await openAuthority();
  ({ definition_id } = await commitTestDefinition({ source: ANALYSIS_LINK_WORKFLOW }));
});
afterAll(async () => { await authority.close(); });

interface LinkRun { readonly run_id: RunId; readonly unit: string; readonly analysis: string; readonly tasks: string; publishTasks(): Promise<string>; decide(target: string, decision: string): Promise<void> }
/** A run with one published analysis and tasks, its worker still running, and no decision yet. */
async function linkRun(): Promise<LinkRun> {
  const { run_id, result } = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input: { topic: "links" } });
  if (!result.ok || result.value.kind !== "committed") throw new Error(JSON.stringify(result));
  const unit = unitOf(run_id, "document");
  const action = await actionOf(authority, run_id, "writer");
  const submit = submitter(authority);
  const committed = async (input: Parameters<typeof submit>[0]): Promise<void> => {
    const outcome = await submit(input);
    if (!outcome.ok || outcome.value.kind !== "committed") throw new Error(JSON.stringify(outcome));
  };
  await committed({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
  await committed({ run_id, event: { kind: "revision_published", unit, artifact: "analysis", body: { findings: [{ id: "F1" }, { id: "F2" }] }, by: action }, writer: executor(action) });
  let sequence = 0;
  const publishTasks = async (): Promise<string> => {
    sequence += 1;
    const body = { tasks: [`revision ${sequence}`] };
    // The worker's attempt publishes the first; a later one is the operator's edit of its predecessor.
    await committed(sequence === 1 ? { run_id, event: { kind: "revision_published", unit, artifact: "tasks", body, by: action }, writer: executor(action) }
      : { run_id, event: { kind: "revision_published", unit, artifact: "tasks", body, predecessor: `${unit}:tasks:${sequence - 1}` }, writer: OPERATOR });
    return `${unit}:tasks:${sequence}`;
  };
  const tasks = await publishTasks();
  await committed({ run_id, event: { kind: "worker_ended", action, result: { kind: "succeeded" } }, writer: executor(action) });
  return { run_id, unit, analysis: `${unit}:analysis:1`, tasks, publishTasks,
    decide: (target, decision) => committed({ run_id, event: { kind: "operator_decided", unit, review: "tasks_review", decision, target,
      payload: decision === "approve" ? {} : { feedback: "again" } } }) };
}
const declarationOf = (run: LinkRun, overrides: Partial<AnalysisLinkDeclaration> = {}): AnalysisLinkDeclaration => ({ run_id: run.run_id, tasks_revision_id: run.tasks,
  entries: [{ source_revision_id: run.analysis, item_path: "/findings/0", task_ids: ["T1"] }], ...overrides });
const declare = (declaration: AnalysisLinkDeclaration, ingress_id: string = crypto.randomUUID()) =>
  commitAnalysisLinkDeclaration(authority.db, { declaration, ingress_id, writer: OPERATOR });
const journaled = async (run_id: string) => authority.db.selectFrom("authority.event").select(["id", "payload", "unit_id"]).where("run_id", "=", run_id)
  .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", ANALYSIS_LINKS_DECLARED)).execute();

describe("the exact context a declaration must name", () => {
  const authorityWith = (overrides: Partial<DeclarationAuthority>): DeclarationAuthority => ({ tasks_revision: { artifact: "tasks" }, is_tasks_revision_approved: true,
    sources: new Map([["analysis-1", { artifact: "analysis", body: { findings: ["one"] } }]]), ...overrides });
  const declaration: AnalysisLinkDeclaration = { run_id: "run-1", tasks_revision_id: "tasks-1",
    entries: [{ source_revision_id: "analysis-1", item_path: "/findings/0", task_ids: ["T1"] }] };
  test("holds when every address does", () => { expect(selectDeclarationRefusal(declaration, authorityWith({}))).toBeNull(); });
  for (const [name, overrides, reason] of [
    ["an absent tasks revision", { tasks_revision: null }, "not part of run"],
    ["a revision of another artifact", { tasks_revision: { artifact: "plan" } }, "is a plan"],
    ["an unapproved tasks revision", { is_tasks_revision_approved: false }, "not approved"],
    ["an absent source revision", { sources: new Map() }, "not part of run"],
    ["a source of another artifact", { sources: new Map([["analysis-1", { artifact: "assessment", body: { findings: ["one"] } }]]) }, "is a assessment"],
    ["a source with no such finding", { sources: new Map([["analysis-1", { artifact: "analysis", body: { findings: [] } }]]) }, "no finding"],
  ] as const) test(`refuses ${name}`, () => { expect(selectDeclarationRefusal(declaration, authorityWith(overrides))).toContain(reason); });
  for (const item_path of ["/requirements/0/status", "/findings", "/findings/00", "/findings/-1", "/findings/0/id"])
    test(`refuses the address ${item_path}, which is no finding`, () => {
      expect(selectDeclarationRefusal({ ...declaration, entries: [{ source_revision_id: "analysis-1", item_path, task_ids: ["T1"] }] }, authorityWith({}))).toContain("no finding");
    });
  test("an entry naming no task is not applicable", () => {
    const linked = { source_revision_id: "a", item_path: "/findings/1", task_ids: ["T1"] };
    expect(selectApplicableEntries([{ source_revision_id: "a", item_path: "/findings/0", task_ids: [] }, linked])).toEqual([linked]);
  });
});

test("after the exact approval, the supplied entries are journaled as written and move no workflow state", async () => {
  const run = await linkRun();
  await run.decide(run.tasks, "approve");
  const inspect = async () => { const read = await readRunInspect(authority.db, run.run_id); return { units: read?.run.units, events: read?.events.length }; };
  const intentCount = async () => (await authority.db.selectFrom("authority.effect_intent").select("id").where("run_id", "=", run.run_id).execute()).length;
  const before = await inspect();
  const intents = await intentCount();
  const operatorEvents = async () => (await authority.db.selectFrom("authority.operator_event").select("id").where("run_id", "=", run.run_id).execute()).length;
  const notices = await operatorEvents();
  const declaration = declarationOf(run, { entries: [{ source_revision_id: run.analysis, item_path: "/findings/1", task_ids: ["T1", "T404"] }] });
  const committed = await declare(declaration);
  const rows = await journaled(run.run_id);
  const after = await inspect();
  expect({ committed: committed.ok && committed.value.kind, rows: rows.map((row) => [row.payload, row.unit_id]), units: after.units, events: after.events,
    intents: await intentCount(), notices: await operatorEvents() }).toEqual({ committed: "committed", rows: [[{ kind: ANALYSIS_LINKS_DECLARED, ...declaration }, null]],
    units: before.units, events: before.events! + 1, intents, notices });
});

test("the named revision decides: a newer unapproved one is refused, and the approved one stays valid after it", async () => {
  const run = await linkRun();
  const refused = await declare(declarationOf(run));
  await run.decide(run.tasks, "request_changes");
  const changesRequested = await declare(declarationOf(run));
  const newer = await run.publishTasks();
  await run.decide(newer, "approve");
  // The first revision only ever had changes requested, and approving a later one does not approve it.
  const first = await declare(declarationOf(run));
  const approved = await declare(declarationOf(run, { tasks_revision_id: newer }));
  expect([refused, changesRequested, first].map((result) => result.ok && result.value.kind)).toEqual(["rejected", "rejected", "rejected"]);
  expect(approved.ok && approved.value.kind).toBe("committed");
  expect((await journaled(run.run_id)).map((row) => row.payload.kind === ANALYSIS_LINKS_DECLARED && row.payload.tasks_revision_id)).toEqual([newer]);
});

test("another run's revisions and an absent finding are refused, whatever the text says", async () => {
  const [run, other] = [await linkRun(), await linkRun()];
  await run.decide(run.tasks, "approve");
  await other.decide(other.tasks, "approve");
  const outcomes = await Promise.all([
    declare(declarationOf(run, { tasks_revision_id: other.tasks })),
    declare(declarationOf(run, { entries: [{ source_revision_id: other.analysis, item_path: "/findings/0", task_ids: ["T1"] }] })),
    declare(declarationOf(run, { entries: [{ source_revision_id: run.analysis, item_path: "/findings/9", task_ids: ["T1"] }] })),
    declare(declarationOf(run, { entries: [{ source_revision_id: run.tasks, item_path: "/findings/0", task_ids: ["T1"] }] })),
  ]);
  expect(outcomes.map((result) => result.ok && result.value.kind)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
  expect(await journaled(run.run_id)).toEqual([]);
});

test("an ingress id replays its result, and refuses other content", async () => {
  const run = await linkRun();
  const refusedId = crypto.randomUUID();
  const refused = await declare(declarationOf(run), refusedId);
  await run.decide(run.tasks, "approve");
  const id = crypto.randomUUID();
  const first = await declare(declarationOf(run), id);
  const replay = await declare(declarationOf(run), id);
  const reused = await declare(declarationOf(run, { entries: [{ source_revision_id: run.analysis, item_path: "/findings/1", task_ids: ["T1"] }] }), id);
  // The refusal was stored: a replay answers from it even though the approval has since arrived.
  const refusedAgain = await declare(declarationOf(run), refusedId);
  const event_id = first.ok && first.value.kind === "committed" ? first.value.event_id : "";
  expect({ replay: replay.ok && replay.value, reused: reused.ok && reused.value.kind, refused: refused.ok && refused.value.kind, again: refusedAgain.ok && refusedAgain.value.kind,
    rows: (await journaled(run.run_id)).map((row) => row.id) }).toEqual({ replay: { kind: "replayed", receipt: { kind: "committed", event_id } }, reused: "conflict",
    refused: "rejected", again: "replayed", rows: [event_id] });
});

test("a declaration does not read as the run moving on, so a standing stall or fault still stands", async () => {
  const run = await linkRun();
  await run.decide(run.tasks, "approve");
  const latest = async () => (await listLiveRuns(authority.db, { after: run.run_id.slice(0, -1), limit: 1000 })).items.find((item) => item.run.id === run.run_id)?.latest_events;
  const before = await latest();
  const committed = await declare(declarationOf(run));
  expect(committed.ok && committed.value.kind).toBe("committed");
  expect(await latest()).toEqual(before);
});

describe("the operator route", () => {
  const TOKEN = "declaration-token";
  let app: Hono;
  beforeAll(() => {
    app = createHttpApp({ db: authority.db, core: authority.core, wake: () => undefined, application_version: "test",
      access: { kind: "token_required", token: TOKEN }, write_policy: browserWritePolicy([]) });
  });
  const post = (run_id: string, body: unknown, token: string | null = TOKEN) => app.request(`/api/runs/${run_id}/analysis-links`, { method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

  test("supplying nothing applicable journals nothing, needs no approval and asks nothing of anyone", async () => {
    const run = await linkRun();
    const responses = await Promise.all([post(run.run_id, { request_id: "none", tasks_revision_id: run.tasks, entries: [] }),
      post(run.run_id, { request_id: "empty", tasks_revision_id: run.tasks, entries: [{ source_revision_id: run.analysis, item_path: "/findings/0", task_ids: [] }] })]);
    expect(await Promise.all(responses.map(async (response) => [response.status, await response.json()]))).toEqual([
      [200, { kind: "no_declaration", run_id: run.run_id }], [200, { kind: "no_declaration", run_id: run.run_id }]]);
    expect(await journaled(run.run_id)).toEqual([]);
  });
  test("a supplied entry commits under the credential's writer, and a body cannot choose it", async () => {
    const run = await linkRun();
    await run.decide(run.tasks, "approve");
    const response = await post(run.run_id, { request_id: "declared", tasks_revision_id: run.tasks, writer: { kind: "engine" },
      entries: [{ source_revision_id: run.analysis, item_path: "/findings/0", task_ids: ["T1"], note: "dropped" }] });
    expect(response.status).toBe(201);
    const row = await authority.db.selectFrom("authority.event").select(["writer", "payload"]).where("run_id", "=", run.run_id)
      .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", ANALYSIS_LINKS_DECLARED)).executeTakeFirstOrThrow();
    expect(row.writer.kind).toBe("operator");
    expect(row.payload).toEqual({ kind: ANALYSIS_LINKS_DECLARED, run_id: run.run_id, tasks_revision_id: run.tasks,
      entries: [{ source_revision_id: run.analysis, item_path: "/findings/0", task_ids: ["T1"] }] });
  });
  test("a refusal is a conflict, a malformed body is refused, and the route needs the operator's credential", async () => {
    const run = await linkRun();
    const valid = { request_id: crypto.randomUUID(), tasks_revision_id: run.tasks, entries: [{ source_revision_id: run.analysis, item_path: "/findings/0", task_ids: ["T1"] }] };
    expect((await post(run.run_id, valid)).status).toBe(409);
    expect((await post(run.run_id, { ...valid, request_id: crypto.randomUUID(), entries: [{ source_revision_id: run.analysis, task_ids: ["T1"] }] })).status).toBe(400);
    expect((await post(run.run_id, valid, null)).status).toBe(401);
    expect((await post("run-absent", { ...valid, request_id: crypto.randomUUID() })).status).toBe(404);
  });
});

describe("the approved-tasks caller", () => {
  const TOKEN = "approval-token";
  let app: Hono;
  beforeAll(() => {
    app = createHttpApp({ db: authority.db, core: authority.core, wake: () => undefined, application_version: "test",
      access: { kind: "token_required", token: TOKEN }, write_policy: browserWritePolicy([]) });
  });
  interface Decide { readonly request_id?: string; readonly decision?: string; readonly target?: string; readonly analysis_links?: unknown }
  const decide = (run: LinkRun, input: Decide = {}) => {
    const decision = input.decision ?? "approve";
    return app.request(`/api/runs/${run.run_id}/units/${encodeURIComponent(run.unit)}/reviews/tasks_review/decide`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ request_id: input.request_id ?? crypto.randomUUID(), decision, target: input.target ?? run.tasks, payload: decision === "approve" ? {} : { feedback: "again" },
        ...(input.analysis_links === undefined ? {} : { analysis_links: input.analysis_links }) }) });
  };
  const decisions = async (run: LinkRun) => (await authority.db.selectFrom("authority.review_decision").select(["target_revision_id", "effect"]).where("run_id", "=", run.run_id).execute());
  const entry = (run: LinkRun, task_ids: readonly string[] = ["T1"], item_path = "/findings/0") => ({ source_revision_id: run.analysis, item_path, task_ids });

  test("an approval naming entries journals them against the exact revision it decides", async () => {
    const run = await linkRun();
    const response = await decide(run, { analysis_links: [entry(run, ["T1", "T2"]), entry(run, [], "/findings/1")] });
    const body = await response.json() as { readonly analysis_links: { readonly kind: string; readonly event_id: string } };
    const rows = await journaled(run.run_id);
    expect({ status: response.status, links: body.analysis_links, rows: rows.map((row) => [row.id, row.payload]), decisions: await decisions(run) }).toEqual({
      status: 201, links: { kind: "committed", event_id: rows[0]!.id },
      rows: [[rows[0]!.id, { kind: ANALYSIS_LINKS_DECLARED, run_id: run.run_id, tasks_revision_id: run.tasks, entries: [entry(run, ["T1", "T2"])] }]],
      decisions: [{ target_revision_id: run.tasks, effect: "approve" }] });
  });
  test("an approval supplying nothing applicable journals nothing, and answers as an approval always has", async () => {
    for (const analysis_links of [undefined, [], [{ source_revision_id: "any", item_path: "/findings/0", task_ids: [] }]]) {
      const run = await linkRun();
      const response = await decide(run, { analysis_links });
      expect([response.status, Object.keys(await response.json() as object).sort(), await journaled(run.run_id), (await decisions(run)).length])
        .toEqual([201, ["event_id", "kind", "run_id"], [], 1]);
    }
  });
  test("a refused entry refuses only the declaration: the approval stands, and the run moves on", async () => {
    const run = await linkRun();
    const response = await decide(run, { analysis_links: [entry(run, ["T1"], "/findings/9")] });
    const body = await response.json() as { readonly analysis_links: { readonly kind: string; readonly reason: string } };
    expect([response.status, body.analysis_links.kind, body.analysis_links.reason, await journaled(run.run_id), await decisions(run)]).toEqual([201, "refused",
      `revision ${run.analysis} has no finding at /findings/9`, [], [{ target_revision_id: run.tasks, effect: "approve" }]]);
  });
  test("request-changes journals nothing and the entries it named are refused, since nothing was approved", async () => {
    const run = await linkRun();
    const response = await decide(run, { decision: "request_changes", analysis_links: [entry(run)] });
    const body = await response.json() as { readonly analysis_links: { readonly kind: string } };
    expect([response.status, body.analysis_links.kind, await journaled(run.run_id)]).toEqual([201, "refused", []]);
  });
  test("a decision refused by the core journals nothing, and links never reach the writer", async () => {
    const run = await linkRun();
    const response = await decide(run, { target: `${run.unit}:tasks:9`, analysis_links: [entry(run)] });
    expect([response.status, await journaled(run.run_id), await decisions(run)]).toEqual([409, [], []]);
  });
  test("a retried request answers with the same decision and declaration, once each", async () => {
    const run = await linkRun();
    const input = { request_id: crypto.randomUUID(), analysis_links: [entry(run)] };
    const first = await (await decide(run, input)).json();
    const replay = await decide(run, input);
    expect([replay.status, await replay.json(), (await journaled(run.run_id)).length, (await decisions(run)).length]).toEqual([200, first, 1, 1]);
  });
  test("no request id a caller may choose lands on the receipt of a decision's links", async () => {
    const run = await linkRun();
    const request_id = crypto.randomUUID();
    expect((await decide(run, { request_id, analysis_links: [entry(run)] })).status).toBe(201);
    const other = declarationOf(run, { entries: [{ source_revision_id: run.analysis, item_path: "/findings/1", task_ids: ["T1"] }] });
    for (const id of [`${request_id}:analysis-links`, `decision-links:operator:${request_id}`])
      expect(await declare(other, id)).toMatchObject({ ok: true, value: { kind: "committed" } });
  });
  test("a malformed entry refuses the request before anything commits", async () => {
    const run = await linkRun();
    const response = await decide(run, { analysis_links: [{ item_path: "/findings/0", task_ids: ["T1"] }] });
    expect([response.status, await journaled(run.run_id), await decisions(run)]).toEqual([400, [], []]);
  });
  test("a failure journaling the links rolls the approval back with them, so a retry can complete both", async () => {
    const run = await linkRun();
    const failed = await commitEvent({ db: authority.db, core: authority.core, wake: () => undefined }, { run_id: run.run_id, ingress_id: crypto.randomUUID(), writer: OPERATOR,
      event: { kind: "operator_decided", unit: run.unit, review: "tasks_review", decision: "approve", target: run.tasks, payload: {} } }, async () => { throw new Error("journal unavailable"); });
    expect([failed.ok, await decisions(run)]).toEqual([false, []]);
    const retried = await decide(run, { analysis_links: [entry(run)] });
    expect([retried.status, (await journaled(run.run_id)).length, (await decisions(run)).length]).toEqual([201, 1, 1]);
  });
});

describe("delivery through the ordered feed", () => {
  const tenant = { producer: "oakridge", namespace: "declarations" };
  let observation: ObservationDatabase;
  let drop: () => Promise<void>;
  let service: Hono;
  beforeAll(async () => {
    const scratch = await scratchDatabase();
    drop = scratch.drop;
    observation = openObservationDatabase(scratch.url);
    await migrateObservation(observation);
    service = createApp({ db: observation, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }] }, profile: oakridgeProfile });
  });
  afterAll(async () => { await observation.destroy(); await drop(); });

  type Fetcher = NonNullable<ObservationOptions["fetcher"]>;
  const toService: Fetcher = async (input, init) => service.request(new Request(input, init));
  const options = (fetcher: Fetcher = toService): ObservationOptions => ({ url: "http://observation.test", namespace: tenant.namespace, token: "ingest", fetcher, poll_ms: 10, log: () => undefined });
  const cursor = () => withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_cursor").select(["commit_txid", "event_id"]).executeTakeFirst());
  /** The feed's newest committed row. Reading it directly is the point: the feed itself may still be holding it back. */
  const journalHead = (db: Database = authority.db) => db.selectFrom("authority.event").select(["id", "commit_txid"])
    .orderBy("commit_txid", "desc").orderBy("id", "desc").limit(1).executeTakeFirstOrThrow();
  const pastFeedGuard = async (event_id: string, db: Database = authority.db): Promise<void> => {
    const deadline = Date.now() + DELIVERY_WAIT_MS;
    for (;;) {
      const at = await cursor();
      const visible = await readCommittedEventsAfter(db, "authority.event", { after: { commit_txid: String(at?.commit_txid ?? 0), id: at?.event_id ?? "" }, limit: 1000 });
      if (visible.some((row) => row.id === event_id)) return;
      if (Date.now() >= deadline) throw new Error(`event ${event_id} never passed the feed's transaction-order guard`);
      await Bun.sleep(20);
    }
  };
  /**
   * Delivers through what the journal holds now. An empty feed read proves nothing: the guard hides
   * every row until all transactions older than it end, on any database of the server. So this waits
   * for the service's cursor to reach the head, and only that counts as delivered.
   */
  const drain = async (db: Database = authority.db): Promise<void> => {
    const head = await journalHead(db);
    const deadline = Date.now() + DELIVERY_WAIT_MS;
    for (;;) {
      const at = await cursor();
      if (at && BigInt(at.commit_txid) >= BigInt(head.commit_txid)) return;
      if (Date.now() >= deadline) throw new Error(`the service never reached event ${head.id}`);
      if (!await publishObservationOnce(db, options())) await Bun.sleep(20);
    }
  };
  const relations = (source_revision: string) => withTenant(observation, tenant, (trx) => trx.selectFrom("observation.item_relation as relation")
    .innerJoin("observation.item_occurrence as source", (join) => join.onRef("source.occurrence_id", "=", "relation.source_occurrence_id")
      .onRef("source.producer", "=", "relation.producer").onRef("source.namespace", "=", "relation.namespace"))
    .select(["relation.relation_id", "relation.target_logical_item_id", "relation.unresolved_target_ref", "relation.asserted_by", "relation.type", "source.json_pointer"])
    .where("source.revision_id", "=", source_revision).orderBy("relation.relation_id").execute());
  const measurementFacts = (run_id: string) => withTenant(observation, tenant, async (trx) => ({
    occurrences: await trx.selectFrom("observation.item_occurrence").selectAll().where("run_id", "=", run_id).orderBy("occurrence_id").execute(),
    evidence: await trx.selectFrom("observation.evidence_set").select("evidence_set_id").execute(),
    executions: await trx.selectFrom("observation.evaluation_execution").select("execution_id").execute(),
    attempts: await trx.selectFrom("observation.grading_provider_attempt").select("execution_id").execute(),
    observations: await trx.selectFrom("observation.grade_observation").select("observation_id").execute(),
  }));
  const headEventId = async (run_id: string): Promise<string> => (await journaled(run_id)).at(-1)!.id;

  test("a journaled declaration survives delivery failing and a publisher restart, and projects once", async () => {
    const run = await linkRun();
    await run.decide(run.tasks, "approve");
    await drain();
    const before = await measurementFacts(run.run_id);
    expect(await declare(declarationOf(run, { entries: [{ source_revision_id: run.analysis, item_path: "/findings/0", task_ids: ["task-a", "task-unknown"] }] }))).toMatchObject({ ok: true, value: { kind: "committed" } });
    // The journal holds it with the service unreachable: nothing about the commit waited on delivery.
    const unreachable = startObservationPublisher(authority.db, options(async () => { throw new Error("connection refused"); }));
    await Bun.sleep(60);
    await unreachable.stop();
    expect(await relations(run.analysis)).toEqual([]);
    // A publisher started afresh, as a restarted process would.
    const reopened = openDatabase(authority.url);
    try { await drain(reopened); } finally { await reopened.destroy(); }
    const projected = await relations(run.analysis);
    expect(projected.map((relation) => [relation.json_pointer, relation.type, relation.asserted_by])).toEqual([
      ["/findings/0", "assesses", "producer_explicit"], ["/findings/0", "assesses", "producer_explicit"]]);
    expect(projected.flatMap((relation) => relation.unresolved_target_ref).sort()).toEqual(["logical_item:task:task-a", "logical_item:task:task-unknown"]);
    expect(await measurementFacts(run.run_id)).toEqual(before);
    expect((await cursor())?.event_id).toBe(await headEventId(run.run_id));
  });

  test("a delivery applied but never acknowledged is not applied twice after a restart", async () => {
    const run = await linkRun();
    await run.decide(run.tasks, "approve");
    await drain();
    await declare(declarationOf(run));
    // The service commits the delivery; its acknowledgement never reaches this publisher.
    let applied = 0;
    const lostAck: Fetcher = async (input, init) => {
      const response = await toService(input, init);
      if (init?.method === "POST") { applied += 1; throw new Error("connection reset before the acknowledgement"); }
      return response;
    };
    await pastFeedGuard(await headEventId(run.run_id));
    await expect(publishObservationOnce(authority.db, options(lostAck))).rejects.toThrow("connection reset");
    expect(applied).toBe(1);
    const projected = await relations(run.analysis);
    expect(projected).toHaveLength(1);
    expect((await cursor())?.event_id).toBe(await headEventId(run.run_id));
    // Restarted, the publisher asks the service where it is and finds nothing left to deliver.
    const reopened = openDatabase(authority.url);
    try {
      const remaining = await readCommittedEventsAfter(reopened, "authority.event", { after: { commit_txid: String((await cursor())!.commit_txid), id: (await cursor())!.event_id }, limit: 10 });
      expect(remaining.filter((row) => row.run_id === run.run_id)).toEqual([]);
      await drain(reopened);
    } finally { await reopened.destroy(); }
    expect(await relations(run.analysis)).toEqual(projected);
    const stored = await readRelationDeclarations(observation, tenant, run.run_id);
    expect(stored.map((declaration) => declaration.projection)).toEqual([{ relation_ids: projected.map((relation) => relation.relation_id), unresolved_sources: [] }]);
  });

  test("an older open transaction anywhere on the server holds a declaration back, and it arrives once that ends", async () => {
    const run = await linkRun();
    await run.decide(run.tasks, "approve");
    await drain();
    const elsewhere = openDatabase(authority.url);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let began!: () => void;
    const beganTransaction = new Promise<void>((resolve) => { began = resolve; });
    const held = elsewhere.transaction().execute(async (trx) => {
      await sql`SELECT pg_current_xact_id()`.execute(trx);
      began();
      await released;
    });
    try {
      await beganTransaction;
      await declare(declarationOf(run));
      // The guard is working as it must: this read is empty though the row has committed.
      expect(await publishObservationOnce(authority.db, options())).toBe(false);
      expect((await journaled(run.run_id))).toHaveLength(1);
      expect(await relations(run.analysis)).toEqual([]);
    } finally { release(); await held; await elsewhere.destroy(); }
    await drain();
    expect(await relations(run.analysis)).toHaveLength(1);
  });

  test("a stale redelivery of a declaration is refused by the cursor and changes nothing", async () => {
    const run = await linkRun();
    await run.decide(run.tasks, "approve");
    await drain();
    const previous = await cursor();
    await declare(declarationOf(run));
    await pastFeedGuard(await headEventId(run.run_id));
    let sent: { readonly body: string; readonly url: RequestInfo | URL } | null = null;
    await publishObservationOnce(authority.db, options(async (input, init) => {
      if (init?.method === "POST") sent = { body: String(init.body), url: input };
      return toService(input, init);
    }));
    expect(JSON.parse((sent as unknown as { body: string }).body).previous.id).toBe(previous?.event_id);
    const projected = await relations(run.analysis);
    const replay = await toService((sent as unknown as { url: RequestInfo | URL }).url, { method: "POST", body: (sent as unknown as { body: string }).body,
      headers: { authorization: "Bearer ingest", "content-type": "application/json" } });
    expect(replay.status).toBe(409);
    expect(await relations(run.analysis)).toEqual(projected);
  });

  test("the same statement declared twice is one relation; an operator's decisions add none", async () => {
    const run = await linkRun();
    await run.decide(run.tasks, "approve");
    await drain();
    await declare(declarationOf(run));
    await declare(declarationOf(run));
    await drain();
    expect(await relations(run.analysis)).toHaveLength(1);
    const decided = await linkRun();
    await decided.decide(decided.tasks, "request_changes");
    const newer = await decided.publishTasks();
    await decided.decide(newer, "approve");
    await drain();
    const outcomes = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_outcome").select(["event_kind", "outcome_kind"])
      .where("run_id", "=", decided.run_id).where("event_kind", "=", "operator_decided").execute());
    expect(outcomes.map((outcome) => outcome.outcome_kind)).toEqual(["ignored", "ignored"]);
    expect(await relations(decided.analysis)).toEqual([]);
    expect(await readRelationDeclarations(observation, tenant, decided.run_id)).toEqual([]);
  });

  test("a target resolves only to that run's own logical task: another run's task of the same id stays out of reach", async () => {
    const [run, other] = [await linkRun(), await linkRun()];
    await run.decide(run.tasks, "approve");
    await other.decide(other.tasks, "approve");
    await drain();
    await withTenant(observation, tenant, async (trx) => {
      await trx.insertInto("observation.logical_item").values({ ...tenant, logical_item_id: logicalItemId({ ...tenant, run_id: other.run_id, scope: "task", producer_local_id: "T1" }),
        run_id: other.run_id, scope: "task", producer_local_id: "T1" }).execute();
    });
    await declare(declarationOf(run));
    await drain();
    expect((await relations(run.analysis)).map((relation) => [relation.target_logical_item_id, relation.unresolved_target_ref])).toEqual([[null, "logical_item:task:T1"]]);
  });
});
