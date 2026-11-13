import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "kysely";
import { createApp } from "../src/http/app";
import { credentialsFromEnv } from "../src/http/ingest-auth";
import { decodeSourceEventDelivery } from "../src/ingest/cursor";
import { oakridgeProfile, createFeed, fixtureBody, integration, scratchDatabase, tenant } from "./grading-fixture";
import { withTenant, type Database } from "../src/storage/database";
import { readSourceCursor } from "../src/storage/capture-store";

/** Every request leaving this process counts as a provider call. */
const realFetch = globalThis.fetch;
let provider_calls = 0;
beforeEach(() => {
  provider_calls = 0;
  globalThis.fetch = (async () => { provider_calls++; throw new Error("provider call attempted"); }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const credentials = { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }],
  grade: [{ ...tenant, token: "grade", reviewer_id: "operator" }] };
const RETIRED: readonly (readonly ["GET" | "POST", string])[] = [
  ["POST", "/v1/evaluations"], ["POST", "/v1/evaluation-jobs"], ["GET", "/v1/evaluation-jobs/job-1"], ["GET", "/v1/items/item-1/evaluation-jobs"],
  ["POST", "/v1/evaluation-executions/execution-1/recover"], ["GET", "/v1/evaluation-eligibility?run_id=run-1"], ["GET", "/v1/runs/run-1/coverage"],
  ["POST", "/v1/grades"], ["GET", "/v1/blind-assignments"], ["POST", "/v1/blind-assignments"], ["POST", "/v1/blind-assignments/one/claim"], ["GET", "/v1/blind-assignments/one"],
  ["POST", "/v1/exports/assay"], ["POST", "/v1/sources/oakridge/sync"], ["GET", "/v1/sources/oakridge/backfill"], ["POST", "/v1/sources/oakridge/backfill"],
  ["GET", "/v1/sources/oakridge/operator-cursor"], ["POST", "/v1/sources/oakridge/operator-events"], ["GET", "/v1/sources/oakridge/human-grades"],
  ["GET", "/v1/sources/oakridge/collaboration-comments?run_id=run-1"]];
const dispatchBody = JSON.stringify({ runner: "jev_direct", identity: { subject_occurrence_id: "item-1", question_id: "q", question_version: "1",
  evaluator_definition_id: "model", attempt_label: "one" } });

async function gradingRecords(db: Database): Promise<Record<string, number>> {
  return withTenant(db, tenant, async (trx) => {
    const counted = await sql<{ evidence: number; executions: number; attempts: number; grades: number }>`SELECT
      (SELECT count(*)::integer FROM observation.evidence_set) AS evidence,
      (SELECT count(*)::integer FROM observation.evaluation_execution) AS executions,
      (SELECT count(*)::integer FROM observation.grading_provider_attempt) AS attempts,
      (SELECT count(*)::integer FROM observation.grade_observation) AS grades`.execute(trx);
    return { ...counted.rows[0]! };
  });
}
const none = { evidence: 0, executions: 0, attempts: 0, grades: 0 };

for (const [method, path] of RETIRED) integration(`${method} ${path} is gone for every capability and dispatches nothing`, async () => scratchDatabase(async (db) => {
  const app = createApp({ db, credentials, profile: oakridgeProfile });
  for (const token of ["ingest", "read", "grade", null]) {
    const response = await app.request(path, { method, body: method === "POST" ? dispatchBody : undefined,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    expect({ path, token, status: response.status }).toEqual({ path, token, status: token === "ingest" ? 403 : 404 });
  }
  expect(provider_calls).toBe(0);
  expect(await gradingRecords(db)).toEqual(none);
}));

for (const decision of ["accept", "request_changes"]) integration(`operator ${decision} advances capture and creates no grading record`, async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") });
  const cursor = await feed.decide("operator_decided");
  expect((await readSourceCursor(db, tenant)).cursor).toEqual(cursor);
  const outcome = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_event_outcome").select(["event_kind", "outcome_kind"])
    .where("event_id", "=", cursor.id).executeTakeFirstOrThrow());
  expect(outcome).toEqual({ event_kind: "operator_decided", outcome_kind: "ignored" });
  expect(await gradingRecords(db)).toEqual(none);
  expect(provider_calls).toBe(0);
}));

test("the retired review-to-grade and collaboration wire variants are refused", () => {
  const position = { previous: { commit_txid: "0", id: "" }, cursor: { commit_txid: "1", id: "event-1" } };
  const fields = { format: "observation.source-event/v1", definition_id: null, artifact_schema_version: null, run_id: "run-1", event_id: "event-1" };
  expect(decodeSourceEventDelivery({ ...position, outcome: { ...fields, kind: "human_grade", event_kind: "operator_decided", evaluator: { kind: "human" },
    target: "rev-1", decision_id: null } })).toBeNull();
  expect(decodeSourceEventDelivery({ ...position, outcome: { ...fields, kind: "collaboration_thread", event_kind: "collaboration_thread" } })).toBeNull();
  expect(decodeSourceEventDelivery({ ...position, outcome: { ...fields, kind: "ignored", event_kind: "operator_decided" } })).not.toBeNull();
});

test("no retired module, entrypoint or credential remains to dispatch outside HTTP", () => {
  const root = resolve(import.meta.dir, "..");
  for (const path of ["src/export", "src/purge", "src/grading/jobs", "src/grading/evidence-packages", "src/grading/catalogue",
    "src/grading/eligibility.ts", "src/grading/coverage.ts", "src/grading/decision-policy.ts", "src/grading/evidence-integrity.ts",
    "src/storage/grading-job-store.ts", "src/storage/eligibility-store.ts", "src/storage/backfill-store.ts", "src/storage/blind-assignment-store.ts",
    "src/storage/coverage-store.ts", "src/storage/export-store.ts", "src/http/exports.ts", "src/runners/human-intake.ts",
    "scripts/jev-live-walkthrough.ts", "scripts/live-grade-subject.ts", "scripts/regenerate-live-fixtures.ts", "src/producers/oakridge/classification.ts"])
    expect({ path, exists: existsSync(resolve(root, path)) }).toEqual({ path, exists: false });
  expect(credentialsFromEnv({} as NodeJS.ProcessEnv)).toEqual({ ingest: [], read: [], grade: [], configure: [] });
});

// A reviewer's submission writing its execution already completed is checked by behavior in human-submission.test.ts.
test("only reconciler admission and a reviewer's submission create executions: no route, script or queue beside them enqueues one", () => {
  const root = resolve(import.meta.dir, "../src");
  const writers = [...new Bun.Glob("**/*.ts").scanSync(root)]
    .filter((path) => readFileSync(resolve(root, path), "utf8").includes('insertInto("observation.evaluation_execution")'));
  expect(writers.sort()).toEqual(["storage/execution-store.ts", "storage/grading-store.ts"]);
  for (const path of new Bun.Glob("http/*.ts").scanSync(root))
    expect({ path, text: readFileSync(resolve(root, path), "utf8") }).not.toMatchObject({ text: expect.stringMatching(/admitRun|claimNext|gradeNext/) });
});
