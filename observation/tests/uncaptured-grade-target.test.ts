import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { Client } from "pg";
import { sql } from "kysely";
import { createApp } from "../src/http/app";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";

// A decision can target a revision published before capture began. It must not
// block the ordered event stream: the decision is kept and delivery moves on.
const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl ? test : test.skip;
const tenant = { producer: "oakridge", namespace: "uncaptured" };
const credentials = { ingest: [{ ...tenant, token: "ingest-fixture" }], read: [{ ...tenant, token: "read-fixture" }] };
const ingestHeaders = { authorization: "Bearer ingest-fixture", "content-type": "application/json" };
const readHeaders = { authorization: "Bearer read-fixture" };

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
  target: "run-1/implementation/a:assessment:1", feedback: {}, effect: "approve", decided_at: "2026-10-30T15:37:07.999Z" });

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
  });
});
