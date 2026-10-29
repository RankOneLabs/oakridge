import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { JsonValue } from "../src/domain/primitives";
import { createApp } from "../src/http/app";
import { langfuseConfigFromEnv } from "../src/langfuse/config";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";

const tenant = { producer: "oakridge", namespace: "langfuse-offline" };
const credentials = { ingest: [{ ...tenant, token: "ingest-token" }],
  read: [{ ...tenant, token: "read-token" }], grade: [{ ...tenant, token: "grade-token" }], export_raw: [] };

async function scratch(work: (db: Database) => Promise<void>): Promise<void> {
  const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_lf_offline_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try { await migrateEmptyDatabase(db); await work(db); }
    finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("missing configuration preserves ingest, projection, lineage and grade reads while sync routes are disabled", async () => scratch(async (db) => {
  const configuration = langfuseConfigFromEnv({});
  expect(configuration).toEqual({ ok: true, value: { status: "disabled" } });
  if (!configuration.ok) return;
  const app = createApp({ db, langfuse: configuration.value, credentials });
  const body = await Bun.file(new URL("../fixtures/oakridge/run-slice/plan-revision.json", import.meta.url)).json() as JsonValue;
  const digest = canonicalDigest(body);
  if (!digest.ok) throw new Error(digest.error.detail);
  const ingest = await app.request("/v1/sources/oakridge/sync", { method: "POST", headers: {
    authorization: "Bearer ingest-token", "idempotency-key": "offline-plan", "content-type": "application/json" },
    body: JSON.stringify({ format: "observation.artifact-revision/v1", source: { ...tenant,
      revision_id: `${tenant.producer}:${tenant.namespace}:plan-1`, run_id: "run-offline",
      unit_id: "run-offline/planning", artifact_kind: "plan", artifact_schema_version: "development-v1",
      definition_bundle: { id: "development", digest: "fixture-bundle" } },
      recorded_at: "2026-10-28T10:00:00.000Z", body, body_digest: digest.value }) });
  expect(ingest.status).toBe(201);
  const items = await app.request("/v1/runs/run-offline/items", { headers: { authorization: "Bearer read-token" } });
  expect(items.status).toBe(200);
  const projected = await items.json() as { items: { occurrence_id: string; item_kind: string }[] };
  const criterion = projected.items.find((item) => item.item_kind === "criterion");
  expect(criterion).toBeDefined();
  if (!criterion) return;
  const lineage = await app.request(`/v1/items/${encodeURIComponent(criterion.occurrence_id)}/lineage`,
    { headers: { authorization: "Bearer read-token" } });
  expect(lineage.status).toBe(200);
  const grade = await app.request("/v1/grades", { method: "POST", headers: {
    authorization: "Bearer grade-token", "content-type": "application/json" }, body: JSON.stringify({
    identity: { subject_occurrence_id: criterion.occurrence_id, evidence_set_id: "offline-evidence",
      question_id: "offline-check", question_version: "1", evaluator_definition_id: "offline-human",
      config_digest: "offline-config", attempt_label: "first" },
    context: { question: { question_id: "offline-check", question_version: "1", target_item_kinds: ["criterion"],
      input_recipe: { expected: "fixture" }, response_kind: "boolean", allowed_values: null,
      missing_evidence_policy: "fail", abstain_semantics: "insufficient", unclear_semantics: "ambiguous",
      interpretation_caveats: "offline test", requires_repository_snapshot: false },
      evidence: { evidence_set_id: "offline-evidence", references: [], is_incomplete: false,
        incompleteness_reason: null },
      evaluator: { evaluator_definition_id: "offline-human", kind: "human", backend_kind: "local",
        provider: "offline-fixture", model: null, prompt_digest: "fixture", config_digest: "offline-config",
        runtime_revision: "1", cost_metadata: null, seed: null, attempt_controls: null } },
    details: { answer: { state: "answered", kind: "boolean", value: true }, reviewer_id: "offline-operator" },
  }) });
  expect(grade.status).toBe(201);
  const history = await app.request(`/v1/items/${encodeURIComponent(criterion.occurrence_id)}/grades`,
    { headers: { authorization: "Bearer read-token" } });
  expect(history.status).toBe(200);
  expect((await history.json() as { total: number }).total).toBe(1);
  for (const [method, path, token] of [
    ["GET", "/v1/langfuse/status", "read-token"],
    ["POST", "/v1/langfuse/projections", "grade-token"],
    ["POST", "/v1/langfuse/reconcile", "grade-token"],
  ] as const) {
    const response = await app.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disabled" });
  }
  const forbidden = await app.request("/v1/langfuse/status", { headers: { Authorization: "Bearer grade-token" } });
  expect(forbidden.status).toBe(403);
}));

test("partial configuration reports only field names, never supplied secret material", () => {
  const parsed = langfuseConfigFromEnv({ OBSERVATION_LANGFUSE_SECRET_KEY: "sensitive-value" });
  expect(parsed.ok).toBe(false);
  expect(JSON.stringify(parsed)).not.toContain("sensitive-value");
});
