import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { createApp } from "../src/http/app";
import { credentialsFromEnv } from "../src/http/ingest-auth";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl || process.env.CI === "true" ? test : test.skip;
const credentials = { ingest: [
  { token: "alpha-ingest", producer: "oakridge", namespace: "alpha" },
  { token: "beta-ingest", producer: "oakridge", namespace: "beta" },
], read: [{ token: "alpha-read", producer: "oakridge", namespace: "alpha" }] };

function delivery(namespace: string, revision: string): object {
  const body = { value: revision };
  const digest = canonicalDigest(body);
  if (!digest.ok) throw new Error(digest.error.detail);
  return { format: "observation.artifact-revision/v1", source: { producer: "oakridge", namespace,
    revision_id: `oakridge:${namespace}:${revision}`, run_id: "run-1", unit_id: "unit-1", artifact_kind: "result",
    artifact_schema_version: "schema-1", definition_bundle: { id: "bundle-1", digest: "bundle-digest-1" } },
    recorded_at: "2026-10-28T10:00:00Z", body, body_digest: digest.value };
}
async function send(app: ReturnType<typeof createApp>, token: string, namespace: string, revision: string): Promise<Response> {
  return await app.request("/v1/sources/oakridge/sync", { method: "POST", headers: { authorization: `Bearer ${token}`,
    "idempotency-key": revision, "content-type": "application/json" }, body: JSON.stringify(delivery(namespace, revision)) });
}

test("a token is configured for exactly one capability and tenant", () => {
  expect(() => credentialsFromEnv({ OBSERVATION_INGEST_CREDENTIALS: JSON.stringify(credentials.ingest),
    OBSERVATION_READ_CREDENTIALS: JSON.stringify([{ token: "alpha-ingest", producer: "oakridge", namespace: "alpha" }]) })).toThrow("unique");
  expect(() => credentialsFromEnv({ OBSERVATION_READ_CREDENTIALS: JSON.stringify(credentials.read),
    OBSERVATION_EXPORT_RAW_CREDENTIALS: JSON.stringify(credentials.read) })).toThrow("unique");
});

integration("ingest credential rejects another tenant and all read or grade routes without disclosure", async () => {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_auth_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try {
      await migrateEmptyDatabase(db);
      const app = createApp({ db, credentials });
      const missing = await send(app, "alpha-ingest", "beta", "not-yet-present");
      const absentResponse = await missing.text();
      expect(missing.status).toBe(403);
      expect((await send(app, "beta-ingest", "beta", "present")).status).toBe(201);
      const existing = await send(app, "alpha-ingest", "beta", "present");
      expect(existing.status).toBe(403);
      expect(await existing.text()).toBe(absentResponse);
      for (const [method, path] of [["GET", "/v1/source-revisions/oakridge:beta:present"],
        ["GET", "/v1/items/item-1"], ["POST", "/v1/grades"]] as const) {
        const response = await app.request(path, { method, headers: { authorization: "Bearer alpha-ingest" } });
        expect(response.status).toBe(403);
      }
      const tenantRead = await app.request("/v1/source-revisions/oakridge:beta:present", { headers: { authorization: "Bearer alpha-read" } });
      expect(tenantRead.status).toBe(404);
    } finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
});
