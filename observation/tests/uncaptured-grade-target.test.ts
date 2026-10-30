import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { Client } from "pg";
import { createApp } from "../src/http/app";
import { openDatabase, type Database } from "../src/storage/database";
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
    expect({ status: delivered.status, decisions: stored.items.map((item) => item.decision_id), position })
      .toEqual({ status: 200, decisions: ["decision-1"], position: { cursor } });
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
