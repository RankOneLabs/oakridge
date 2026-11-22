import { expect, test } from "bun:test";
import { createApp } from "../../observation/src/http/app";
import { ARTIFACT_KEYS } from "../../observation/src/producers/oakridge/artifact-versions";
import { selectRegistration } from "../../observation/src/producers/oakridge/catalogue";
import { oakridgeProfile } from "../../observation/src/producers/oakridge/profile";
import { openDatabase, withTenant } from "../../observation/src/storage/database";
import { readLogicalItemLineage } from "../../observation/src/storage/grading-record-store";
import { migrateEmptyDatabase } from "../../observation/src/storage/migrate";
import { artifactSchemaVersion } from "../src/adapters/observation-schema-version";
import { publishObservationOnce, type ObservationOptions } from "../src/adapters/observation";
import type { Workflow } from "../src/core-client/core-types";
import { readPinnedDefinition } from "../src/storage/read-store";
import { assessmentWorkflow, openAssessmentRun, sampleProposal } from "./assessment-fixture";
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

test("sending an authored proposal to one or two DBOS recipients preserves its task association", async () => {
  const authority = await openAuthority();
  const scratch = await scratchDatabase();
  const observation = openDatabase(scratch.url);
  try {
    await migrateEmptyDatabase(observation);
    const work = assessmentWorkflow.stages.work;
    const workflow = {
      ...assessmentWorkflow,
      stages: { work: { ...work,
        artifacts: {
          ...work.artifacts,
          spec: { kind: "record", schema: { requirements: "list(requirement)" } },
          assessment: { ...work.artifacts.assessment,
            schema: { item_assessments: "list(judgment)", proposals: "list(feedback_proposal)" },
            validate: [] },
        },
        workers: { ...work.workers, builder_a: { ...work.workers.builder_a, produces: ["part_a", "spec"] } },
      } },
      schemas: {
        requirement: { id: "ident", analysis_finding_ids: "list(ident)" },
        judgment: { subject: { kind: "text", id: "ident" }, status: "text" },
      },
    } satisfies Workflow;
    const profile = oakridgeProfile([]);
    const dev = ARTIFACT_KEYS.development;
    const registry = new Map([
      ["spec", selectRegistration({ definition_id: dev.analysis.spec.definition_id, stage: dev.analysis.spec.stage,
        artifact_kind: "spec", artifact_schema_version: dev.analysis.spec.schema_version })!.extractors],
      ["assessment", selectRegistration({ definition_id: dev.integration.assessment.definition_id, stage: dev.integration.assessment.stage,
        artifact_kind: "assessment", artifact_schema_version: dev.integration.assessment.schema_version })!.extractors],
    ]);
    const runs = [await openAssessmentRun(authority, workflow), await openAssessmentRun(authority, workflow)];
    const definition = await readPinnedDefinition(authority.db, runs[0]!.run_id);
    if (!definition) throw new Error("missing assessment fixture definition");
    const tenant = { producer: "oakridge", namespace: "dispatch" };
    const app = createApp({ db: observation, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [] },
      profile: { ...profile, extraction: { ...profile.extraction, definitions: (declaration) =>
        declaration.definition_id === definition.definition_id && declaration.stage === "work" &&
        declaration.artifact_schema_version === artifactSchemaVersion(definition, declaration.stage, declaration.artifact_kind)
          ? (registry.get(declaration.artifact_kind) ?? []).map((extractor) => ({
            ...extractor, schema_version: declaration.artifact_schema_version,
          })) : undefined } } });
    const options: ObservationOptions = { url: "http://observation.test", namespace: tenant.namespace, token: "ingest",
      fetcher: (input, init) => Promise.resolve(app.request(new Request(input, init))) };
    for (const [index, run] of runs.entries()) {
      for (const [worker, artifact] of [["builder_a", "part_a"], ["builder_b", "part_b"]] as const)
        expect(await run.publish({ worker, artifact, body: { text: artifact } })).toMatchObject({ value: { kind: "committed" } });
      expect(await run.publish({ worker: "builder_a", artifact: "spec", body: { requirements: [{ id: "R1", analysis_finding_ids: [] }] } }))
        .toMatchObject({ value: { kind: "committed" } });
      await run.end("builder_a");
      await run.end("builder_b");
      const subject = (await run.revision("part_a"))!.id;
      const judgment = { subject: { kind: "requirement", id: "R1" }, status: "met" };
      expect(await run.publish({ worker: "assessor", artifact: "assessment", subject, body: { item_assessments: [judgment], proposals: [] } }))
        .toMatchObject({ value: { kind: "committed" } });
      const cited = (await run.revision("assessment"))!.id;
      expect(await run.publish({ worker: "assessor", artifact: "assessment", subject, body: {
        item_assessments: [judgment], proposals: [{ ...sampleProposal, citation: { revision_id: cited, pointer: "/item_assessments/0" } }],
      } })).toMatchObject({ value: { kind: "committed" } });
      await run.end("assessor");
      const [{ id: item }] = await run.rows("authority.feedback_item");
      const recipients = index === 0 ? ["builder_a"] : ["builder_a", "builder_b"];
      expect((await run.authorize(item, subject, sampleProposal.instruction, recipients)).status).toBe(201);
      expect((await run.decide({ decision: "send", dispositions: [{ kind: "dispatch", item, instruction: sampleProposal.instruction, recipients }] })).status).toBe(201);
      expect((await run.counts()).assignments).toBe(recipients.length);
    }
    const count = await authority.db.selectFrom("authority.event").select((eb) => eb.fn.countAll().as("count")).executeTakeFirstOrThrow();
    const deadline = Date.now() + 30_000;
    let delivered = 0;
    while (delivered < Number(count.count) && Date.now() < deadline) {
      if (await publishObservationOnce(authority.db, options)) delivered++;
      else await Bun.sleep(25);
    }
    expect(delivered).toBe(Number(count.count));
    for (const run of runs) {
      const lineage = await readLogicalItemLineage(observation, tenant, profile.composite, run.run_id, "R1", { limit: 100, offset: 0 });
      expect(lineage.items.flatMap((entry) => entry.kind === "contribution" && entry.item.item_kind === "feedback_proposal" ? [entry.item.item_path] : []))
        .toEqual(["/proposals/0"]);
    }
  } finally {
    await observation.destroy();
    await scratch.drop();
    await authority.close();
  }
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
