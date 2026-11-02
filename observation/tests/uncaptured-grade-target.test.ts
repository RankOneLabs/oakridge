import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { Client } from "pg";
import { sql } from "kysely";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { createApp } from "../src/http/app";
import { repairSourceEvent } from "../src/storage/capture-store";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";

// A decision can target a revision published before capture began. It must not
// block the ordered event stream: the decision is kept and delivery moves on.
const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl ? test : test.skip;
const tenant = { producer: "oakridge", namespace: "uncaptured" };
const credentials = { ingest: [{ ...tenant, token: "ingest-fixture" }], read: [{ ...tenant, token: "read-fixture" }],
  grade: [{ ...tenant, token: "operator-fixture", reviewer_id: "operator-test" }] };
const ingestHeaders = { authorization: "Bearer ingest-fixture", "content-type": "application/json" };
const readHeaders = { authorization: "Bearer read-fixture" };
const revision_id = "run-1/implementation/a:assessment:1";
function revision(run_id = "run-1") {
  const body = { findings: [{ summary: "review finding" }] };
  const digest = canonicalDigest(body);
  if (!digest.ok) throw new Error(digest.error.detail);
  return { format: "observation.artifact-revision/v1", source: { ...tenant,
    revision_id: `${tenant.producer}:${tenant.namespace}:${revision_id}`, run_id,
    unit_id: "run-1/implementation/a", artifact_kind: "assessment", artifact_schema_version: "development-v1",
    definition_bundle: { id: "development", digest: "fixture-bundle" }, predecessor_id: null, subject_id: null },
    recorded_at: "2026-10-30T15:00:00.000Z", body, body_digest: digest.value } as const;
}
async function send(app: ReturnType<typeof createApp>, previous: { commit_txid: string; id: string },
  index: number, outcome: object) {
  const cursor = { commit_txid: String(index), id: (outcome as { event_id: string }).event_id };
  const response = await app.request("/v1/sources/oakridge/events", { method: "POST", headers: ingestHeaders,
    body: JSON.stringify({ previous, cursor, outcome }) });
  return { response, cursor };
}

async function scratch(work: (db: Database) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const admin = new Client({ connectionString: serverUrl });
  const name = `observation_uncaptured_${randomBytes(6).toString("hex")}`;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try { await migrateEmptyDatabase(db); await work(db); }
    finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}

const decisionOn = (event_id: string, decision_id: string) => ({ format: "observation.source-event/v1", definition_bundle: null,
  artifact_schema_version: null, kind: "human_grade", event_kind: "operator_decided", run_id: "run-1", event_id, decision_id,
  evaluator: { kind: "human" }, unit: "run-1/implementation/a", review: "assessment_review", decision: "accept",
  target: "run-1/implementation/a:assessment:1", feedback: {}, effect: "approve", decided_at: "2026-10-30T15:37:07.999Z" } as const);

integration("a live decision on an uncaptured revision is kept and the cursor moves past it", async () => {
  await scratch(async (db) => {
    const app = createApp({ db, credentials });
    const cursor = { commit_txid: "1001568", id: "event-decision" };
    const delivered = await app.request("/v1/sources/oakridge/events", { method: "POST", headers: ingestHeaders,
      body: JSON.stringify({ previous: { commit_txid: "0", id: "" }, cursor, outcome: decisionOn("event-decision", "decision-1") }) });
    const stored = await (await app.request("/v1/sources/oakridge/human-grades", { headers: readHeaders })).json() as
      { items: { decision_id: string }[] };
    const position = await (await app.request("/v1/sources/oakridge/cursor", { headers: { authorization: "Bearer ingest-fixture" } })).json();
    const issuesResponse = await app.request("/v1/sources/oakridge/issues", { headers: readHeaders });
    const issues = await issuesResponse.json() as { items: { cause: string; resolution_state: string }[] };
    const unauthenticated = await app.request("/v1/sources/oakridge/issues");
    expect({ status: delivered.status, decisions: stored.items.map((item) => item.decision_id), position,
      issues: issues.items.map((issue) => [issue.cause, issue.resolution_state]), unauthenticated: unauthenticated.status })
      .toEqual({ status: 200, decisions: ["decision-1"], position: { cursor },
        issues: [["missing_grade_target", "unresolved"]], unauthenticated: 403 });
  });
});

integration("a backfilled decision on an uncaptured revision is kept and the backfill moves past it", async () => {
  await scratch(async (db) => {
    const app = createApp({ db, credentials });
    const before = { source: "review_decision", created_at: new Date(0).toISOString(), id: "" };
    const after = { source: "review_decision", created_at: "2026-10-30T05:10:00.000Z", id: "decision-2" };
    const backfilled = await app.request("/v1/sources/oakridge/backfill", { method: "POST", headers: ingestHeaders,
      body: JSON.stringify({ previous: before, position: after,
        counts: { review_decision: { active: 1, archived: 0 }, collaboration_thread: { active: 0, archived: 0 } },
        outcome: decisionOn("review_decision:decision-2", "decision-2") }) });
    const stored = await (await app.request("/v1/sources/oakridge/human-grades", { headers: readHeaders })).json() as
      { items: { decision_id: string }[] };
    const checkpoint = await (await app.request("/v1/sources/oakridge/backfill",
      { headers: { authorization: "Bearer ingest-fixture" } })).json() as { position: unknown };
    expect({ status: backfilled.status, decisions: stored.items.map((item) => item.decision_id), position: checkpoint.position })
      .toEqual({ status: 200, decisions: ["decision-2"], position: after });
  });
});

integration("live feedback preserves every JSON kind and distinguishes JSON null from SQL NULL", async () => {
  await scratch(async (db) => {
    const app = createApp({ db, credentials });
    const samples = [
      { value: "lgtm", kind: "string" }, { value: [], kind: "array" },
      { value: ["a"], kind: "array" }, { value: 0, kind: "number" },
      { value: null, kind: "null" }, { value: {}, kind: "object" },
    ];
    let previous = { commit_txid: "0", id: "" };
    for (const [index, sample] of samples.entries()) {
      const event_id = `feedback-${index}`;
      const cursor = { commit_txid: String(index + 1), id: event_id };
      const response = await app.request("/v1/sources/oakridge/events", { method: "POST", headers: ingestHeaders,
        body: JSON.stringify({ previous, cursor, outcome: { ...decisionOn(event_id, event_id), feedback: sample.value } }) });
      expect(response.status).toBe(200);
      const result = await withTenant(db, tenant, (trx) => sql<{ kind: string; feedback: unknown; is_sql_null: boolean }>`
        SELECT jsonb_typeof(feedback) AS kind, feedback, (feedback IS NULL) AS is_sql_null
        FROM observation.source_human_grade WHERE event_id = ${event_id}`.execute(trx));
      expect(result.rows[0]).toEqual({ kind: sample.kind, feedback: sample.value, is_sql_null: false });
      previous = cursor;
    }
    await withTenant(db, tenant, (trx) => sql`UPDATE observation.source_human_grade SET feedback = NULL
      WHERE event_id = 'feedback-0'`.execute(trx));
    const absent = await withTenant(db, tenant, (trx) => sql<{ kind: string | null; is_sql_null: boolean }>`
      SELECT jsonb_typeof(feedback) AS kind, feedback IS NULL AS is_sql_null FROM observation.source_human_grade
      WHERE event_id = 'feedback-0'`.execute(trx));
    expect(absent.rows[0]).toEqual({ kind: null, is_sql_null: true });
  });
});

integration("historical feedback preserves all six JSON kinds", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const samples = ["lgtm", [], ["a"], 0, null, {}] as const;
  const kinds = ["string", "array", "array", "number", "null", "object"];
  const initial = { source: "review_decision", created_at: new Date(0).toISOString(), id: "" };
  for (const [index, feedback] of samples.entries()) {
    const event_id = `history-feedback-${index}`;
    const response = await app.request("/v1/sources/oakridge/backfill", { method: "POST", headers: ingestHeaders,
      body: JSON.stringify({ previous: initial, position: initial, replay: true,
        counts: { review_decision: { active: 0, archived: 0 }, collaboration_thread: { active: 0, archived: 0 } },
        outcome: { ...decisionOn(event_id, event_id), feedback } }) });
    expect(response.status).toBe(200);
    const stored = await withTenant(db, tenant, (trx) => sql<{ kind: string; feedback: unknown; is_sql_null: boolean }>`
      SELECT jsonb_typeof(feedback) AS kind, feedback, feedback IS NULL AS is_sql_null
      FROM observation.source_human_grade WHERE event_id = ${event_id}`.execute(trx));
    expect(stored.rows[0]).toEqual({ kind: kinds[index], feedback, is_sql_null: false });
  }
}));

integration("ignored event kinds advance without issues and health reports the unresolved count", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  let previous = { commit_txid: "0", id: "" };
  for (const [index, event_kind] of ["worker_started", "worker_ended", "retry_requested", "cancel_requested"].entries()) {
    const delivered = await send(app, previous, index + 1, { format: "observation.source-event/v1",
      definition_bundle: null, artifact_schema_version: null, kind: "ignored", event_kind,
      run_id: "run-1", event_id: `ignored-${index}` });
    expect(delivered.response.status).toBe(200);
    previous = delivered.cursor;
  }
  const health = await app.request("/v1/sources/oakridge/issue-health", { headers: readHeaders });
  expect(await health.json()).toEqual({ unresolved: 0, resolved: 0 });
}));

integration("missing collaboration target reconciles exactly once when captured", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const thread = { format: "observation.source-event/v1", definition_bundle: null, artifact_schema_version: null,
    kind: "collaboration_thread", event_kind: "collaboration_thread", run_id: "run-1", event_id: "thread-1",
    unit: "run-1/implementation/a", revision_id, context: { title: "review", anchor: null },
    messages: [{ id: "message-1", body: { text: "hello", author: "operator" }, created_at: "2026-10-30T15:00:00Z" }] };
  expect((await send(app, { commit_txid: "0", id: "" }, 1, thread)).response.status).toBe(200);
  const issuesBefore = await (await app.request("/v1/sources/oakridge/issues", { headers: readHeaders })).json() as
    { items: { cause: string; resolution_state: string }[] };
  expect(issuesBefore.items.map((item) => [item.cause, item.resolution_state])).toEqual([["missing_collaboration_revision", "unresolved"]]);
  const capture = () => app.request("/v1/sources/oakridge/sync", { method: "POST", headers: { ...ingestHeaders,
    "idempotency-key": "thread-capture" }, body: JSON.stringify(revision()) });
  expect((await capture()).status).toBe(201);
  expect((await capture()).status).toBe(201);
  const comments = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_collaboration_comment")
    .select("message_id").execute());
  const health = await (await app.request("/v1/sources/oakridge/issue-health", { headers: readHeaders })).json();
  expect({ comments: comments.map((row) => row.message_id), health })
    .toEqual({ comments: ["message-1"], health: { unresolved: 0, resolved: 1 } });
}));

integration("missing grade target reconciles once through the historical grade writer", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const outcome = decisionOn("grade-later", "grade-later");
  expect((await send(app, { commit_txid: "0", id: "" }, 1, outcome)).response.status).toBe(200);
  const capture = () => app.request("/v1/sources/oakridge/sync", { method: "POST", headers: { ...ingestHeaders,
    "idempotency-key": "grade-capture" }, body: JSON.stringify(revision()) });
  expect((await capture()).status).toBe(201);
  expect((await capture()).status).toBe(201);
  const grades = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grade_observation")
    .select("observation_id").execute());
  const health = await (await app.request("/v1/sources/oakridge/issue-health", { headers: readHeaders })).json();
  expect({ grades: grades.length, health }).toEqual({ grades: 1, health: { unresolved: 0, resolved: 1 } });
}));

integration("repair refuses conflicting derived content instead of absorbing it", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const outcome = decisionOn("grade-conflict", "grade-conflict");
  expect((await send(app, { commit_txid: "0", id: "" }, 1, outcome)).response.status).toBe(200);
  expect((await app.request("/v1/sources/oakridge/sync", { method: "POST", headers: { ...ingestHeaders,
    "idempotency-key": "grade-conflict-capture" }, body: JSON.stringify(revision()) })).status).toBe(201);
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.question_definition")
    .set({ interpretation_caveats: "changed" }).execute());
  await expect(repairSourceEvent(db, tenant, outcome, "1")).rejects.toThrow("question_definition content conflict");
}));

integration("repair enriches only the missing historical collection relationship", async () => scratch(async (db) => {
  const original = { format: "observation.source-event/v1", definition_bundle: null,
    artifact_schema_version: "development-v1", kind: "artifact_revision", event_kind: "revision_published",
    run_id: "run-1", event_id: "revision-history", revision: revision() } as const;
  expect(await repairSourceEvent(db, tenant, original, "1")).toBe("repaired");
  const enriched = { ...original, revision: { ...original.revision,
    source: { ...original.revision.source, collection_key: "cohort-one" } } };
  expect(await repairSourceEvent(db, tenant, enriched, "1")).toBe("unchanged");
  const stored = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision")
    .select(["collection_key", "body_digest"]).executeTakeFirstOrThrow());
  expect(stored).toEqual({ collection_key: "cohort-one", body_digest: original.revision.body_digest });
  const changed = { ...enriched, revision: { ...enriched.revision,
    source: { ...enriched.revision.source, artifact_kind: "other" } } };
  await expect(repairSourceEvent(db, tenant, changed, "1")).rejects.toThrow("content conflict");
}));

integration("run mismatch survives target capture until an operator resolves it", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const outcome = decisionOn("mismatch-1", "mismatch-1");
  expect((await send(app, { commit_txid: "0", id: "" }, 1, outcome)).response.status).toBe(200);
  const envelope = revision("run-2");
  expect((await app.request("/v1/sources/oakridge/sync", { method: "POST", headers: { ...ingestHeaders,
    "idempotency-key": "mismatch-capture" }, body: JSON.stringify(envelope) })).status).toBe(201);
  // Retrying the original decision after capture upgrades a missing-target issue to a run mismatch.
  await repairSourceEvent(db, tenant, outcome, "1");
  const issues = await (await app.request("/v1/sources/oakridge/issues", { headers: readHeaders })).json() as
    { items: { issue_id: string; cause: string; resolution_state: string }[] };
  const mismatch = issues.items.find((item) => item.cause === "run_mismatch");
  expect(mismatch?.resolution_state).toBe("unresolved");
  const resolved = await app.request("/v1/sources/oakridge/issues/resolve", { method: "POST",
    headers: { authorization: "Bearer operator-fixture", "content-type": "application/json" },
    body: JSON.stringify({ issue_id: mismatch!.issue_id, detail: "reviewed provenance" }) });
  expect(resolved.status).toBe(200);
}));

integration("corrected mapping retries an unmapped event and resolves its issue", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const provenance = { format: "observation.source-event/v1", definition_bundle: null, artifact_schema_version: null,
    event_kind: "worker_started", run_id: "run-1", event_id: "mapping-1" } as const;
  const unmapped = { ...provenance, kind: "unmapped", reason: "unknown variant" } as const;
  expect((await send(app, { commit_txid: "0", id: "" }, 1, unmapped)).response.status).toBe(200);
  await repairSourceEvent(db, tenant, { ...provenance, kind: "ignored", event_kind: "worker_started" }, "1");
  const health = await (await app.request("/v1/sources/oakridge/issue-health", { headers: readHeaders })).json();
  expect(health).toEqual({ unresolved: 0, resolved: 1 });
}));
