import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { createApp } from "../src/http/app";
import { decodeCapture } from "../src/ingest/capture";
import { openDatabase, withTenant } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { startObservation } from "../src/main";

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
    finally { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
  } finally { await admin.end(); }
}

function envelope(body: unknown, revision_id = "oakridge:local-dev:rev-123"): Record<string, unknown> {
  const hashed = canonicalDigest(body);
  if (!hashed.ok) throw new Error(hashed.error.detail);
  return { format: "observation.artifact-revision/v1", source: { producer: "oakridge", namespace: "local-dev",
    revision_id, run_id: "run-1", unit_id: "unit-1", artifact_kind: "build_result", artifact_schema_version: "schema-sha256:abc",
    definition_bundle: { id: "bundle-1", digest: "bundle-sha256:def" } }, recorded_at: "2026-10-28T10:00:00.000Z",
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
      definition_bundle_id: "bundle-1", definition_bundle_digest: "bundle-sha256:def", body: { z: 1, a: ["x"] } });
    const rehashed = canonicalDigest(revision.body);
    expect(rehashed.ok && rehashed.value).toBe(revision.body_digest);
  } finally { await db.destroy(); }
}));

test("capture validates the identity components and submitted canonical digest", () => {
  const mismatched = decodeCapture(envelope({ value: 1 }, "oakridge:other:rev-1"), "key-1");
  expect(mismatched.ok).toBe(false);
  const wrongDigest = envelope({ value: 1 });
  wrongDigest.body_digest = "canonical-json/v1:" + "0".repeat(64);
  const result = decodeCapture(wrongDigest, "key-2");
  expect(result.ok).toBe(false);
});

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
