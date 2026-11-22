import { expect, test } from "bun:test";
import { createApp } from "../../observation/src/http/app";
import { oakridgeProfile } from "../../observation/src/producers/oakridge/profile";
import { openDatabase, withTenant } from "../../observation/src/storage/database";
import { migrateEmptyDatabase } from "../../observation/src/storage/migrate";
import { publishObservationOnce, type ObservationOptions } from "../src/adapters/observation";
import type { Workflow } from "../src/core-client/core-types";
import { executor, launch, openAuthority, scratchDatabase, submitter, unitOf } from "./authority-fixture";
import { commitTestDefinition } from "./committed-fixture";

const source: Workflow = {
  workflow: "publication_delivery", input: {},
  run: { units: { document: { stage: "document" } }, outcome: {} },
  stages: { document: {
    input: {}, done_when: "false", outcome: {},
    artifacts: { draft: { kind: "document", schema: "text" }, output: { kind: "document", schema: "text" }, extra: { kind: "document", schema: "text" },
      poll: { kind: "record", schema: "text" } },
    workers: {
      author: { kind: "agent", prompts: { initial: "review-loop/write.md" }, inputs: { topic: '"fixture"' }, produces: ["draft"] },
      editor: { kind: "agent", when: "published(draft)", prompts: { initial: "review-loop/write.md", revise: "review-loop/revise.md" },
        inputs: { source: "{ draft: latest(draft) }", topic: '"fixture"' }, produces: ["output", "extra"] },
      poller: { kind: "code", operation: "value.publish", every: "1s", inputs: { value: '"fixed"' }, produces: ["poll"] },
    },
  } },
};

async function withDelivery(run: (fixture: Awaited<ReturnType<typeof openDelivery>>) => Promise<void>): Promise<void> {
  const fixture = await openDelivery();
  try { await run(fixture); } finally { await fixture.close(); }
}
async function openDelivery() {
  const authority = await openAuthority();
  const scratch = await scratchDatabase();
  const observation = openDatabase(scratch.url);
  await migrateEmptyDatabase(observation);
  const tenant = { producer: "oakridge", namespace: "delivery" };
  const credentials = { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }] };
  const app = createApp({ db: observation, credentials, profile: oakridgeProfile([]) });
  const options: ObservationOptions = { url: "http://observation.test", namespace: tenant.namespace, token: "ingest",
    fetcher: async (input, init) => app.request(new Request(input, init)) };
  const { definition_id } = await commitTestDefinition({ source });
  const { run_id, result } = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input: {} });
  expect(result).toMatchObject({ value: { kind: "committed" } });
  const unit = unitOf(run_id, "document");
  const submit = submitter(authority);
  const publish = async (artifact: string, body: string, worker?: string) => {
    const by = worker ? await attempt(worker) : null;
    const predecessor = await authority.db.selectFrom("authority.artifact_revision").select("id")
      .where("run_id", "=", run_id).where("artifact", "=", artifact).orderBy("seq", "desc").executeTakeFirst();
    expect(await submit({ run_id, event: { kind: "revision_published", unit, artifact, body, by, predecessor: predecessor?.id ?? null },
      ...(by ? { writer: executor(by.action) } : {}) })).toMatchObject({ value: { kind: "committed" } });
  };
  const attempt = async (worker: string) => authority.db.selectFrom("authority.attempt").select(["action_id as action", "seq"])
    .where("run_id", "=", run_id).where("worker", "=", worker).orderBy("created_at", "desc").orderBy("seq", "desc").executeTakeFirstOrThrow();
  const revisions = (artifact: string) => authority.db.selectFrom("authority.artifact_revision").selectAll()
    .where("run_id", "=", run_id).where("artifact", "=", artifact).orderBy("seq").execute();
  const captures = (artifact: string) => withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_revision").selectAll()
    .where("artifact_kind", "=", artifact).orderBy("revision_id").execute());
  const cursor = () => withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_cursor")
    .selectAll().executeTakeFirstOrThrow());
  const reset = (saved: Awaited<ReturnType<typeof cursor>>) => withTenant(observation, tenant, (trx) =>
    trx.updateTable("observation.source_event_cursor").set({ commit_txid: Number(saved.commit_txid), event_id: saved.event_id }).execute());
  const deliver = () => publishObservationOnce(authority.db, options);
  const next = async (): Promise<boolean> => {
    const deadline = Date.now() + 15_000;
    do {
      if (await deliver()) return true;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
    return false;
  };
  const eventCount = () => authority.db.selectFrom("authority.event").select((eb) => eb.fn.countAll().as("count"))
    .where("run_id", "=", run_id).executeTakeFirstOrThrow();
  const drain = async () => {
    const target = Number((await eventCount()).count);
    const delivered = () => withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_outcome")
      .select((eb) => eb.fn.countAll().as("count")).executeTakeFirstOrThrow());
    while (Number((await delivered()).count) < target) expect(await next()).toBe(true);
  };
  const replay = async (saved: Awaited<ReturnType<typeof cursor>>, count: number) => {
    await reset(saved);
    for (let index = 0; index < count; index++) expect(await next()).toBe(true);
  };
  return { run_id, unit, submit, publish, attempt, revisions, captures, cursor, eventCount, next, replay, deliver, drain,
    async close() { await observation.destroy(); await scratch.drop(); await authority.close(); } };
}

test("three periodic publication events advance the cursor three times and replay only two inserted revisions", async () => {
  await withDelivery(async (fixture) => {
    await fixture.drain();
    const initial = await fixture.cursor();
    for (const body of ["one", "one", "two"]) await fixture.publish("poll", body, "poller");
    const cursors = [];
    for (let index = 0; index < 3; index++) {
      expect(await fixture.next()).toBe(true);
      cursors.push((await fixture.cursor()).event_id);
    }
    expect(new Set(cursors).size).toBe(3);
    expect(cursors).not.toContain(initial.event_id);
    expect(await fixture.deliver()).toBe(false);
    const expected = (await fixture.revisions("poll")).map(({ id, body }) => ({ revision_id: id, body }));
    expect(expected).toHaveLength(2);
    const captured = async () => (await fixture.captures("poll")).map(({ revision_id, body }) => ({ revision_id, body }));
    expect(await captured()).toEqual(expected as Awaited<ReturnType<typeof captured>>);
    await fixture.replay(initial, 3);
    expect(await captured()).toEqual(expected as Awaited<ReturnType<typeof captured>>);
  });
}, 60_000);

test("worker and operator publications preserve their original inputs through retry, newer source revisions and redelivery", async () => {
  await withDelivery(async (fixture) => {
    await fixture.drain();
    const initial = await fixture.cursor();
    await fixture.publish("draft", "first", "author");
    const first = await fixture.attempt("editor");
    await fixture.publish("output", "one", "editor");
    expect(await fixture.submit({ run_id: fixture.run_id, writer: executor(first.action),
      event: { kind: "worker_ended", action: first.action, result: { kind: "failed", code: "test", detail: "retry" } } }))
      .toMatchObject({ value: { kind: "committed" } });
    await fixture.publish("draft", "second");
    expect(await fixture.submit({ run_id: fixture.run_id, event: { kind: "retry_requested", unit: fixture.unit, worker: "editor" } }))
      .toMatchObject({ value: { kind: "committed" } });
    const retry = await fixture.attempt("editor");
    await fixture.publish("output", "two", "editor");
    await fixture.publish("output", "operator edit");
    await fixture.publish("draft", "third");
    const drafts = await fixture.revisions("draft");
    const output = await fixture.revisions("output");
    const binding = (index: number) => ({ input: "source", unit: fixture.unit, revision_id: drafts[index]!.id });
    expect(output.map(({ origin_kind, by_action_id, by_seq, input_bindings }) => ({ origin_kind, by_action_id, by_seq, input_bindings }))).toEqual([
      { origin_kind: "worker", by_action_id: first.action, by_seq: first.seq, input_bindings: [binding(0)] },
      { origin_kind: "worker", by_action_id: retry.action, by_seq: retry.seq, input_bindings: expect.arrayContaining([binding(1)]) },
      { origin_kind: "operator_edit", by_action_id: null, by_seq: null, input_bindings: [binding(1),
        { input: "$previous", unit: fixture.unit, revision_id: output[1]!.id }] },
    ]);
    const captured = async () => (await fixture.captures("output")).map(({ revision_id, origin, input_bindings }) => ({ revision_id, origin, input_bindings }));
    const expected = output.map((row) => ({ revision_id: row.id, input_bindings: row.input_bindings, origin: row.origin_kind === "worker"
      ? { kind: "worker", action_id: row.by_action_id, seq: row.by_seq } : { kind: "operator_edit" } }));
    await fixture.drain();
    expect(await captured()).toEqual(expected as Awaited<ReturnType<typeof captured>>);
    await fixture.replay(initial, Number((await fixture.eventCount()).count) - 1);
    expect(await captured()).toEqual(expected as Awaited<ReturnType<typeof captured>>);
  });
}, 60_000);
