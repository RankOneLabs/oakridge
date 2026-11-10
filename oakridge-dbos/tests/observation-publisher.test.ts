import { sampleDefinition, commitTestDefinition } from "./committed-fixture";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import type { Event } from "../src/core-client/core-types";
import type { Workflow } from "../src/core-client/core-types";
import { createApp } from "../../observation/src/http/app";
import { oakridgeProfile } from "../../observation/src/producers/oakridge/profile";
import { openDatabase as openObservationDatabase, withTenant } from "../../observation/src/storage/database";
import { migrateEmptyDatabase as migrateObservation } from "../../observation/src/storage/migrate";
import { publishObservationOnce, startObservationPublisher, type ObservationOptions } from "../src/adapters/observation";
import { artifactSchemaVersion } from "../src/adapters/observation-schema-version";
import { jsonText, openDatabase } from "../src/storage/database";
import { readDefinition } from "../src/storage/read-store";
import { actionOf, executor, launch, openAuthority, sampleWorkflow, scratchDatabase, submitter, unitOf, type Authority } from "./authority-fixture";

let authority: Authority;
beforeAll(async () => { authority = await openAuthority(); });
afterAll(async () => { await authority.close(); });

test("adapter, Oakridge and observation outages replay committed events from the service cursor", async () => {
  const scratch = await scratchDatabase();
  const observation = openObservationDatabase(scratch.url);
  const tenant = { producer: "oakridge", namespace: "drills" };
  try {
    await migrateObservation(observation);
    const app = createApp({ db: observation, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }] }, profile: oakridgeProfile });
    const fetcher: NonNullable<ObservationOptions["fetcher"]> = async (input, init) => app.request(new Request(input, init));
    const options: ObservationOptions = { url: "http://observation.test", namespace: tenant.namespace, token: "ingest", fetcher,
      poll_ms: 20, log: () => undefined };
    const outcomeCount = async (): Promise<number> => Number((await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_outcome")
      .select((eb) => eb.fn.countAll<number>().as("count")).executeTakeFirstOrThrow())).count);
    const runUntil = async (expected: number, db = authority.db, source = options): Promise<number> => {
      const publisher = startObservationPublisher(db, source);
      const deadline = Date.now() + 30_000;
      try {
        let delivered = await outcomeCount();
        while (delivered < expected && Date.now() < deadline) {
          await Bun.sleep(20);
          delivered = await outcomeCount();
        }
        return delivered;
      } finally {
        await publisher.stop();
      }
    };
    const { definition_id } = await sampleDefinition();
    const prompted = await commitTestDefinition({ source: sampleWorkflow("review-loop"), prompt_edit: { path: "review-loop/write.md", content: "changed prompt" } });
    const changedSchema = sampleWorkflow("review-loop") as unknown as { stages: { document: { artifacts: { draft: { schema: { extra?: string } } } } } };
    changedSchema.stages.document.artifacts.draft.schema.extra = "text";
    const typed = await commitTestDefinition({ source: changedSchema as unknown as Workflow });
    const [originalDefinition, promptDefinition, typeDefinition] = await Promise.all([
      readDefinition(authority.db, definition_id), readDefinition(authority.db, prompted.definition_id), readDefinition(authority.db, typed.definition_id),
    ]);
    expect({ prompt: artifactSchemaVersion(promptDefinition!, "document", "draft") === artifactSchemaVersion(originalDefinition!, "document", "draft"),
      type: artifactSchemaVersion(typeDefinition!, "document", "draft") === artifactSchemaVersion(originalDefinition!, "document", "draft") })
      .toEqual({ prompt: true, type: false });
    const { run_id } = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input: { topic: "capture" } });
    expect(await runUntil(1)).toBe(1);
    // A new adapter instance starts from the cursor persisted in observation.
    const unit = unitOf(run_id, "document");
    const action = await actionOf(authority, run_id, "writer");
    const submit = submitter(authority);
    await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
    await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "Long" }, by: action }, writer: executor(action) });
    expect(await runUntil(3)).toBe(3);
    // Reopen the Oakridge database handle as a restarted process would.
    const reopened = openDatabase(authority.url);
    try {
      await submit({ run_id, event: { kind: "worker_ended", action, result: { kind: "succeeded" } }, writer: executor(action) });
      await submit({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision: "request_changes",
        target: `${unit}:draft:1`, payload: { feedback: "shorter" } } });
      expect(await runUntil(5, reopened)).toBe(5);
    } finally { await reopened.destroy(); }
    // Delivery fails across an adapter restart while commits continue.
    const offline: ObservationOptions = { ...options, fetcher: async () => { throw new Error("offline"); } };
    await submit({ run_id, event: { kind: "cancel_requested" } });
    // The core does not know these shapes; real authority rows exercise the adapter's fallback.
    const unexpected = crypto.randomUUID();
    const absentArtifact = crypto.randomUUID();
    await authority.db.insertInto("authority.event").values({ id: unexpected, run_id, unit_id: null,
      payload: jsonText({ kind: "future_event" } as unknown as Event), writer: jsonText({ kind: "operator", subject: "test" }) }).execute();
    await authority.db.insertInto("authority.event").values({ id: absentArtifact, run_id, unit_id: unit,
      payload: jsonText({ kind: "revision_published", unit, artifact: "not_declared", body: "x" }),
      writer: jsonText({ kind: "operator", subject: "test" }) }).execute();
    await expect(publishObservationOnce(authority.db, offline)).rejects.toThrow("offline");
    const unavailable = startObservationPublisher(authority.db, offline);
    await Bun.sleep(100);
    await unavailable.stop();
    const restartedUnavailable = startObservationPublisher(authority.db, offline);
    await Bun.sleep(100);
    await restartedUnavailable.stop();
    const beforeRecovery = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_cursor").select("event_id").executeTakeFirstOrThrow());
    expect(await outcomeCount()).toBe(5);
    expect(await runUntil(8)).toBe(8);
    // A later transaction with the smaller txid must hold the whole tail back.
    const holder = openDatabase(authority.url);
    let inserted!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { inserted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const older = crypto.randomUUID();
    const newer = crypto.randomUUID();
    const pending = holder.transaction().execute(async (trx) => {
      await trx.insertInto("authority.event").values({ id: older, run_id, unit_id: null,
        payload: jsonText({ kind: "cancel_requested" }), writer: jsonText({ kind: "operator", subject: "test" }) }).execute();
      inserted();
      await gate;
    });
    await ready;
    try {
      await authority.db.insertInto("authority.event").values({ id: newer, run_id, unit_id: null,
        payload: jsonText({ kind: "cancel_requested" }), writer: jsonText({ kind: "operator", subject: "test" }) }).execute();
      const guarded = startObservationPublisher(authority.db, options);
      await Bun.sleep(100);
      await guarded.stop();
      expect(await outcomeCount()).toBe(8);
      release();
      await pending;
      expect(await runUntil(10)).toBe(10);
    } finally { release(); await pending; await holder.destroy(); }
    const committed = await authority.db.selectFrom("authority.event").select("id").where("run_id", "=", run_id).execute();
    const delivered = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_outcome")
      .select(["event_id", "event_kind", "outcome_kind"]).execute());
    const afterRecovery = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_cursor").select("event_id").executeTakeFirstOrThrow());
    const unmapped = await app.request("/v1/sources/oakridge/unmapped", { headers: { authorization: "Bearer read" } });
    const retired = await app.request("/v1/sources/oakridge/human-grades", { headers: { authorization: "Bearer read" } });
    const grading = await withTenant(observation, tenant, (trx) => sql<{ evidence: number; executions: number; grades: number }>`SELECT
      (SELECT count(*)::integer FROM observation.evidence_set) AS evidence,
      (SELECT count(*)::integer FROM observation.evaluation_execution) AS executions,
      (SELECT count(*)::integer FROM observation.grade_observation) AS grades`.execute(trx));
    expect({ ids: delivered.map((row) => row.event_id).sort(), committed: committed.map((row) => row.id).sort(),
      held: beforeRecovery.event_id !== afterRecovery.event_id,
      unmapped: (await unmapped.json() as { items: { event_id: string }[] }).items.map((item) => item.event_id).sort(),
      decision: delivered.find((row) => row.event_kind === "operator_decided")?.outcome_kind })
      .toMatchObject({ ids: committed.map((row) => row.id).sort(), committed: committed.map((row) => row.id).sort(), held: true,
        unmapped: [unexpected, absentArtifact].sort(), decision: "ignored" });
    expect((await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_revision").select("revision_id").execute()))
      .map((row) => row.revision_id)).toEqual([`${unit}:draft:1`]);
    expect({ status: retired.status, grading: grading.rows[0] }).toEqual({ status: 404, grading: { evidence: 0, executions: 0, grades: 0 } });
  } finally { await observation.destroy(); await scratch.drop(); }
});

test("accept and request-changes pass through the mapper and ordered ingest as ignored, with no grading record", async () => {
  const scratch = await scratchDatabase();
  const observation = openObservationDatabase(scratch.url);
  const tenant = { producer: "oakridge", namespace: "approvals" };
  try {
    await migrateObservation(observation);
    const app = createApp({ db: observation, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [] }, profile: oakridgeProfile });
    const provider_calls: string[] = [];
    const options: ObservationOptions = { url: "http://observation.test", namespace: tenant.namespace, token: "ingest",
      fetcher: async (input, init) => { provider_calls.push(String(input)); return app.request(new Request(input, init)); } };
    const { definition_id } = await sampleDefinition();
    const { run_id } = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input: { topic: "approvals" } });
    const unit = unitOf(run_id, "document");
    const decisions = ["accept", "request_changes"].map((decision) => ({ id: crypto.randomUUID(), run_id, unit_id: unit,
      payload: jsonText({ kind: "operator_decided", unit, review: "editor", decision, target: `${unit}:draft:1`, payload: {} } as Event),
      writer: jsonText({ kind: "operator" as const, subject: "test" }) }));
    await authority.db.insertInto("authority.event").values(decisions).execute();
    while (await publishObservationOnce(authority.db, options)) { /* drain the ordered tail */ }
    const outcomes = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_outcome")
      .select(["event_id", "event_kind", "outcome_kind"]).where("event_kind", "=", "operator_decided").where("run_id", "=", run_id).execute());
    expect(outcomes.map((row) => row.outcome_kind)).toEqual(["ignored", "ignored"]);
    expect(outcomes.map((row) => row.event_id).sort()).toEqual(decisions.map((row) => row.id).sort());
    const grading = await withTenant(observation, tenant, (trx) => sql<{ evidence: number; executions: number; attempts: number; grades: number }>`SELECT
      (SELECT count(*)::integer FROM observation.evidence_set) AS evidence,
      (SELECT count(*)::integer FROM observation.evaluation_execution) AS executions,
      (SELECT count(*)::integer FROM observation.grading_provider_attempt) AS attempts,
      (SELECT count(*)::integer FROM observation.grade_observation) AS grades`.execute(trx));
    expect(grading.rows[0]).toEqual({ evidence: 0, executions: 0, attempts: 0, grades: 0 });
    expect(provider_calls.every((url) => url.startsWith("http://observation.test/v1/sources/oakridge/"))).toBe(true);
    // A restarted publisher finds nothing left: the cursor already passed both decisions.
    expect(await publishObservationOnce(authority.db, options)).toBe(false);
  } finally { await observation.destroy(); await scratch.drop(); }
});

test("each launch delivers its committed grading choice beside its input, and a replay delivers the same", async () => {
  const scratch = await scratchDatabase();
  const replica = await scratchDatabase();
  const tenant = { producer: "oakridge", namespace: "launch-config" };
  const services = [openObservationDatabase(scratch.url), openObservationDatabase(replica.url)];
  try {
    const { definition_id } = await sampleDefinition();
    const launches = await Promise.all([
      launch(authority, { definition_id, request_id: crypto.randomUUID(), input: { topic: "on" }, config: { sessions: {}, grading_enabled: true } }),
      launch(authority, { definition_id, request_id: crypto.randomUUID(), input: { topic: "off" },
        config: { sessions: { document: { writer: { harness: "codex", model: "gpt-5.5", effort: null } } }, grading_enabled: false } }),
      launch(authority, { definition_id, request_id: crypto.randomUUID(), input: { topic: "none" } })]);
    const delivered = async (observation: (typeof services)[number]) => {
      await migrateObservation(observation);
      const app = createApp({ db: observation, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [] }, profile: oakridgeProfile });
      const options: ObservationOptions = { url: "http://observation.test", namespace: tenant.namespace, token: "ingest",
        fetcher: async (input, init) => app.request(new Request(input, init)) };
      while (await publishObservationOnce(authority.db, options)) { /* drain the ordered tail */ }
      const rows = await withTenant(observation, tenant, (trx) => trx.selectFrom("observation.source_event_outcome").select(["run_id", "detail"])
        .where("outcome_kind", "=", "run_input").where("run_id", "in", launches.map((entry) => entry.run_id)).execute());
      return Object.fromEntries(rows.map((row) => [row.run_id, row.detail as { input: unknown; config: unknown }]));
    };
    const first = await delivered(services[0]!);
    // A fresh service starts at the beginning: replay reads the run's committed config, not anything current.
    const replayed = await delivered(services[1]!);
    const [on, off, none] = launches.map((entry) => first[entry.run_id]);
    expect([on, off, none]).toEqual([
      expect.objectContaining({ input: { topic: "on" }, config: { sessions: {}, grading_enabled: true } }),
      expect.objectContaining({ input: { topic: "off" }, config: { sessions: { document: { writer: { harness: "codex", model: "gpt-5.5", effort: null } } },
        grading_enabled: false } }),
      expect.objectContaining({ input: { topic: "none" }, config: null })]);
    expect(launches.map((entry) => replayed[entry.run_id])).toEqual([on, off, none]);
  } finally { for (const db of services) await db.destroy(); await scratch.drop(); await replica.drop(); }
});
