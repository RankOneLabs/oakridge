import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { canonicalDigest } from "canonical-json";
import { createApp } from "../src/http/app";
import { decodeCapture } from "../src/ingest/capture";
import type { SourceEventDelivery } from "../src/ingest/cursor";
import type { PinnedExpectation } from "../src/grading/question";
import { openDatabase, withTenant } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { startObservation } from "../src/main";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl || process.env.CI === "true" ? test : test.skip;
const tenant = { producer: "oakridge", namespace: "local-dev" };
const credentials = { ingest: [{ ...tenant, token: "ingest-secret" }], read: [{ ...tenant, token: "read-secret" }] };

async function scratch(work: (url: string) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_capture_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    try { await work(url.href); }
    finally { await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}

function envelope(body: unknown, revision_id = "oakridge:local-dev:rev-123"): Record<string, unknown> {
  const hashed = canonicalDigest(body);
  if (!hashed.ok) throw new Error(hashed.error.detail);
  return { format: "observation.artifact-revision/v2", source: { producer: "oakridge", namespace: "local-dev",
    revision_id, run_id: "run-1", unit_id: "unit-1", artifact_kind: "build_result", artifact_schema_version: "schema-sha256:abc",
    definition_id: "definition-1" }, recorded_at: "2026-10-28T10:00:00.000Z",
    body, body_digest: hashed.value };
}
async function post(app: ReturnType<typeof createApp>, input: unknown, key = "delivery-1"): Promise<Response> {
  return await app.request("/v1/sources/oakridge/sync", { method: "POST", headers: { authorization: "Bearer ingest-secret",
    "idempotency-key": key, "content-type": "application/json" }, body: JSON.stringify(input) });
}
async function counts(db: ReturnType<typeof openDatabase>): Promise<{ revisions: number; receipts: number }> {
  return withTenant(db, tenant, async (trx) => {
    const revisions = await sql<{ count: string }>`SELECT count(*)::text AS count FROM observation.source_revision`.execute(trx);
    const receipts = await sql<{ count: string }>`SELECT count(*)::text AS count FROM observation.ingest_receipt`.execute(trx);
    return { revisions: Number(revisions.rows[0]?.count), receipts: Number(receipts.rows[0]?.count) };
  });
}

integration("three identical deliveries keep one revision and receipt, and read returns its provenance", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const app = createApp({ db, credentials });
    const payload = envelope({ z: 1, a: ["x"] });
    const responses = await Promise.all([post(app, payload), post(app, payload), post(app, payload)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    const newKey = await post(app, payload, "delivery-2");
    expect(await newKey.json()).toEqual(bodies[0]);
    expect(await counts(db)).toEqual({ revisions: 1, receipts: 1 });
    const read = await app.request("/v1/source-revisions/oakridge:local-dev:rev-123", { headers: { authorization: "Bearer read-secret" } });
    expect(read.status).toBe(200);
    const revision = await read.json();
    expect(revision).toMatchObject({ id: "oakridge:local-dev:rev-123", producer: "oakridge", namespace: "local-dev",
      run_id: "run-1", unit_id: "unit-1", artifact_kind: "build_result", artifact_schema_version: "schema-sha256:abc",
      definition_id: "definition-1", body: { z: 1, a: ["x"] } });
    const rehashed = canonicalDigest(revision.body);
    expect(rehashed.ok && rehashed.value).toBe(revision.body_digest);
  } finally { await db.destroy(); }
}));

integration("live operator grades keep question pins equal to each run's captured provenance", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const app = createApp({ db, credentials });
    const base = decodeCapture(envelope({ cohort_id: "cohort", decisions_made: [], approaches_rejected: [],
      acceptance_criteria: [{ id: "criterion", text: "Works" }] }), "base");
    if (!base.ok) throw new Error(base.error.detail);
    const expectations: readonly PinnedExpectation[] = [
      { definition_id: "definition-a", artifact_schema_version: "schema-a" },
      { definition_id: "definition-a", artifact_schema_version: "schema-a" },
      { definition_id: "definition-b", artifact_schema_version: "schema-a" },
      { definition_id: "definition-a", artifact_schema_version: "schema-b" },
    ];
    let previous = { commit_txid: "0", id: "" };
    for (const [index, pinned_expectation] of expectations.entries()) {
      const run_id = `run-pins-${index}`;
      const revision_id = `revision-pins-${index}`;
      const captured = { ...base.value.envelope, source: { ...base.value.envelope.source, ...pinned_expectation,
        revision_id: `${tenant.producer}:${tenant.namespace}:${revision_id}`, run_id, artifact_kind: "brief" } };
      expect((await post(app, captured, revision_id)).status).toBe(201);
      const event_id = `decision-pins-${index}`;
      const cursor = { commit_txid: String(index + 1), id: event_id };
      const delivery: SourceEventDelivery = { previous, cursor, outcome: {
        format: "observation.source-event/v1", ...pinned_expectation, kind: "human_grade", event_kind: "operator_decided",
        run_id, event_id, decision_id: event_id, evaluator: { kind: "human" }, unit: captured.source.unit_id,
        review: "assessment_review", decision: "accept", target: revision_id, feedback: {}, effect: "approve",
        decided_at: "2026-11-02T12:00:00Z" } };
      const request = { method: "POST", headers: { authorization: "Bearer ingest-secret", "content-type": "application/json" },
        body: JSON.stringify(delivery) };
      const response = await app.request("/v1/sources/oakridge/events", request);
      if (response.status !== 200) throw new Error(await response.text());
      previous = cursor;
    }
    const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution as e")
      .innerJoin("observation.item_occurrence as i", "i.occurrence_id", "e.subject_occurrence_id")
      .innerJoin("observation.source_revision as r", "r.revision_id", "i.revision_id")
      .innerJoin("observation.question_definition as q", (join) => join.onRef("q.producer", "=", "e.producer")
        .onRef("q.namespace", "=", "e.namespace").onRef("q.question_id", "=", "e.question_id")
        .onRef("q.question_version", "=", "e.question_version"))
      .innerJoin("observation.grade_observation as g", "g.execution_id", "e.execution_id")
      .select(["e.question_id", "e.question_version", "q.expected_definition_id", "q.expected_artifact_schema_version",
        "r.definition_id", "r.artifact_schema_version", "g.origin"])
      .where("e.producer", "=", tenant.producer).where("e.namespace", "=", tenant.namespace).orderBy("r.run_id").execute());
    expect(rows.map((row) => ({ definition_id: row.expected_definition_id,
      artifact_schema_version: row.expected_artifact_schema_version }))).toEqual([...expectations]);
    expect(rows.map((row) => ({ definition_id: row.definition_id,
      artifact_schema_version: row.artifact_schema_version }))).toEqual([...expectations]);
    expect(rows[0]?.question_id).toBe(rows[1]?.question_id);
    expect(new Set(rows.map((row) => row.question_id)).size).toBe(3);
    expect(rows.map((row) => [row.question_version, row.origin]))
      .toEqual(expectations.map(() => ["1", "workflow_approval"]));
    const questions = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.question_definition").select("question_id").execute());
    expect(questions).toHaveLength(3);
  } finally { await db.destroy(); }
}));

integration("live source feedback retains all JSON value kinds", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const app = createApp({ db, credentials });
    const feedbackValues = ["Fix this", [], ["Fix this"], 0, null, { note: "Fix this" }];
    let previous = { commit_txid: "0", id: "" };
    for (const [index, feedback] of feedbackValues.entries()) {
      const event_id = `feedback-${index}`;
      const cursor = { commit_txid: String(index + 1), id: event_id };
      const response = await app.request("/v1/sources/oakridge/events", { method: "POST",
        headers: { authorization: "Bearer ingest-secret", "content-type": "application/json" },
        body: JSON.stringify({ previous, cursor, outcome: {
          format: "observation.source-event/v1", definition_id: null, artifact_schema_version: null,
          kind: "human_grade", event_kind: "operator_decided", run_id: "run-live", event_id,
          decision_id: event_id, evaluator: { kind: "human" }, unit: "run-live/cohort/a",
          review: "assessment_review", decision: "request_build_changes", target: "pending-capture",
          feedback, effect: "request_changes", decided_at: "2026-11-02T12:00:00Z",
        } }) });
      if (response.status !== 200) throw new Error(await response.text());
      previous = cursor;
    }
    const stored = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_human_grade")
      .select("feedback").where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .orderBy("event_id").execute());
    expect(stored.map((row) => row.feedback)).toEqual(feedbackValues);
  } finally { await db.destroy(); }
}));

test("capture validates the identity components and submitted canonical digest", () => {
  const mismatched = decodeCapture(envelope({ value: 1 }, "oakridge:other:rev-1"), "key-1");
  expect(mismatched.ok).toBe(false);
  const wrongDigest = envelope({ value: 1 });
  wrongDigest.body_digest = "canonical-json/v1:" + "0".repeat(64);
  const result = decodeCapture(wrongDigest, "key-2");
  expect(result.ok).toBe(false);
  const crossTenant = envelope({ value: 1 });
  (crossTenant.source as Record<string, unknown>).subject_id = "oakridge:other:rev-1";
  expect(decodeCapture(crossTenant, "key-3").ok).toBe(false);
});

integration("capture retains explicit predecessor and subject ids while preserving body identity", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const app = createApp({ db, credentials });
    const first = envelope({ claim: "one" }, "oakridge:local-dev:rev-1");
    expect((await post(app, first, "link-1")).status).toBe(201);
    const second = envelope({ claim: "one" }, "oakridge:local-dev:rev-2");
    (second.source as Record<string, unknown>).predecessor_id = "oakridge:local-dev:rev-1";
    (second.source as Record<string, unknown>).subject_id = "oakridge:local-dev:rev-1";
    expect((await post(app, second, "link-2")).status).toBe(201);
    const read = await app.request("/v1/source-revisions/oakridge:local-dev:rev-2",
      { headers: { authorization: "Bearer read-secret" } });
    expect(await read.json()).toMatchObject({ predecessor_id: "oakridge:local-dev:rev-1",
      subject_id: "oakridge:local-dev:rev-1" });
    const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision")
      .selectAll().where("revision_id", "=", "rev-2").executeTakeFirstOrThrow());
    expect(row.predecessor_id).toBe("rev-1");
    const rehashed = canonicalDigest(row.body);
    expect(String(rehashed.ok && rehashed.value)).toBe(row.body_digest);
    const altered = envelope({ claim: "one" }, "oakridge:local-dev:rev-2");
    expect((await post(app, altered, "link-3")).status).toBe(409);
  } finally { await db.destroy(); }
}));

integration("conflicting body records both digests without changing the immutable revision", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const app = createApp({ db, credentials });
    await post(app, envelope({ version: 1 }));
    const before = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision").selectAll().executeTakeFirstOrThrow());
    const conflict = await post(app, envelope({ version: 2 }), "delivery-2");
    expect(conflict.status).toBe(409);
    const body = await conflict.json();
    expect(body.error.code).toBe("revision_identity_conflict");
    const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.ingest_receipt").selectAll()
      .where("outcome", "=", "revision_identity_conflict").execute());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revision_id: "rev-123", stored_digest: before.body_digest,
      incoming_digest: body.error.incoming_digest });
    const after = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision").selectAll().executeTakeFirstOrThrow());
    expect(after).toEqual(before);
    const retry = await post(app, envelope({ version: 2 }), "delivery-2");
    expect(await retry.json()).toEqual(body);
  } finally { await db.destroy(); }
}));

integration("absent and null bodies are refused while an empty object is stored", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const app = createApp({ db, credentials });
    const absent = envelope({});
    delete absent.body;
    expect((await post(app, absent)).status).toBe(400);
    const nil = envelope({});
    nil.body = null;
    expect((await post(app, nil)).status).toBe(400);
    expect(await counts(db)).toEqual({ revisions: 0, receipts: 0 });
    expect((await post(app, envelope({}))).status).toBe(201);
    const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision").select("body").executeTakeFirstOrThrow());
    expect(row.body).toEqual({});
  } finally { await db.destroy(); }
}));

integration("a string body, such as a markdown spec, is stored as a JSON string", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const app = createApp({ db, credentials });
    const spec = "# Spec 3A\n\nStatus: draft";
    expect((await post(app, envelope(spec))).status).toBe(201);
    const read = await app.request("/v1/source-revisions/oakridge:local-dev:rev-123", { headers: { authorization: "Bearer read-secret" } });
    expect((await read.json()).body).toBe(spec);
    const live = envelope(spec, "oakridge:local-dev:rev-live");
    const delivered = await app.request("/v1/sources/oakridge/events", { method: "POST",
      headers: { authorization: "Bearer ingest-secret", "content-type": "application/json" },
      body: JSON.stringify({ previous: { commit_txid: "0", id: "" }, cursor: { commit_txid: "1", id: "event-1" },
        outcome: { format: "observation.source-event/v1", kind: "artifact_revision", event_kind: "revision_published",
          run_id: "run-1", event_id: "event-1", definition_id: "definition-1",
          artifact_schema_version: "schema-sha256:abc", revision: live } }) });
    expect(delivered.status).toBe(200);
  } finally { await db.destroy(); }
}));

integration("crash between mirror and receipt rolls both back, then retry succeeds", async () => scratch(async (url) => {
  const db = openDatabase(url);
  try {
    await migrateEmptyDatabase(db);
    const crashing = createApp({ db, credentials, captureHooks: { afterMirror: async () => { throw new Error("injected crash"); } } });
    expect((await post(crashing, envelope({ value: 1 }))).status).toBe(500);
    expect(await counts(db)).toEqual({ revisions: 0, receipts: 0 });
    const healthy = createApp({ db, credentials });
    expect((await post(healthy, envelope({ value: 1 }))).status).toBe(201);
    const read = await healthy.request("/v1/source-revisions/oakridge:local-dev:rev-123", { headers: { authorization: "Bearer read-secret" } });
    expect(read.status).toBe(200);
    expect(await counts(db)).toEqual({ revisions: 1, receipts: 1 });
  } finally { await db.destroy(); }
}));

integration("service boots and serves ingest using only its own database and configured credentials", async () => scratch(async (url) => {
  const service = await startObservation({ OBSERVATION_DATABASE_URL: url, OBSERVATION_PORT: "0",
    OBSERVATION_INGEST_CREDENTIALS: JSON.stringify(credentials.ingest), OBSERVATION_READ_CREDENTIALS: JSON.stringify(credentials.read) });
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/v1/sources/oakridge/sync`, { method: "POST",
      headers: { authorization: "Bearer ingest-secret", "idempotency-key": "live-1", "content-type": "application/json" },
      body: JSON.stringify(envelope({ live: true })) });
    expect(response.status).toBe(201);
  } finally { await service.stop(); }
}));

test("capture v2 accepts the explicit definition and artifact schema provenance", () => {
  expect(decodeCapture(envelope({ value: 1 }), "v2")).toMatchObject({ ok: true,
    value: { envelope: { format: "observation.artifact-revision/v2",
      source: { definition_id: "definition-1", artifact_schema_version: "schema-sha256:abc" } } } });
});

test("the previous capture version is rejected with the named format failure", () => {
  const input = { ...envelope({ value: 1 }), format: "observation.artifact-revision/" + "v1" };
  expect(decodeCapture(input, "previous")).toEqual({ ok: false,
    error: { operation: "decode_capture", entity_id: "envelope", detail: "invalid capture format" } });
});

for (const field of ["definition_id", "artifact_schema_version"] as const) {
  for (const value of [undefined, ""]) {
    test(`capture rejects ${value === undefined ? "absent" : "empty"} ${field} without inferring provenance`, () => {
      const input = envelope({ value: 1 });
      const invalid = { ...input, source: { ...input.source as object, [field]: value } };
      expect(decodeCapture(invalid, "invalid")).toEqual({ ok: false,
        error: { operation: "decode_capture", entity_id: `source.${field}`, detail: `${field} is required` } });
    });
  }
}
