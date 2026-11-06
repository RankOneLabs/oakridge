import type { JsonValue } from "../src/domain/primitives";
import { expect, test } from "bun:test";
import { sql } from "kysely";
import { canonicalDigest } from "canonical-json";
import { createApp } from "../src/http/app";
import { withTenant, type Database } from "../src/storage/database";
import type { ItemOccurrenceId } from "../src/domain/identity";
import { seedGradingRecords } from "./schema-fixture";
import { scratchGrading, tenant } from "./grading-fixture";

interface ExecutionState { readonly status: string; readonly ended_at?: Date | null; readonly error?: string | null;
  readonly lease_owner?: string | null; readonly lease_expires_at?: Date | null; readonly attempts?: number }
interface ExecutionFixture { readonly occurrence_id: ItemOccurrenceId; readonly evidence_set_id: string; readonly state: ExecutionState }
async function insertExecution(db: Database, input: ExecutionFixture) {
  const { occurrence_id, evidence_set_id, state } = input;
  const execution_id = crypto.randomUUID();
  const digest = canonicalDigest(execution_id);
  if (!digest.ok) throw new Error(digest.error.detail);
  return withTenant(db, tenant, (trx) => trx.insertInto("observation.evaluation_execution").values({ ...tenant, execution_id,
    subject_occurrence_id: occurrence_id, evidence_set_id, question_id: "relevance", question_version: "1",
    evaluator_definition_id: "human", attempt_label: "fixture", idempotency_digest: digest.value, run_id: "run-1", ...state })
    .returningAll().executeTakeFirstOrThrow());
}

test("execution lifecycle enforces status, zero attempts, terminal facts and claimed leases", () => scratchGrading(async (db, occurrence_id) => {
  const evidence_set_id = await seedGradingRecords(db, occurrence_id);
  const now = new Date();
  const states: readonly ExecutionState[] = [{ status: "queued" }, { status: "claimed", lease_owner: "worker", lease_expires_at: now },
    { status: "reclaimable" }, { status: "budget_deferred" }, { status: "completed", ended_at: now },
    { status: "failed", ended_at: now, error: "provider refused" }];
  const inserted = [];
  for (const state of states) inserted.push(await insertExecution(db, { occurrence_id, evidence_set_id, state }));
  expect(inserted.map((row) => ({ status: row.status, attempts: row.attempts, runner: row.runner_name,
    estimated_cost: row.estimated_cost, retry_limit: row.retry_limit, next_attempt_at: row.next_attempt_at instanceof Date })))
    .toEqual(states.map((state) => ({ status: state.status, attempts: 0, runner: null, estimated_cost: 0, retry_limit: 0, next_attempt_at: true })));
  const refused: readonly ExecutionState[] = [ { status: "running" }, { status: "terminal" }, { status: "skipped_budget" },
    { status: "other" }, { status: "queued", attempts: -1 }, { status: "queued", ended_at: now },
    { status: "completed" }, { status: "failed", ended_at: now }, { status: "completed", ended_at: now, error: "wrong" },
    { status: "claimed" }, { status: "claimed", lease_owner: "worker" }, { status: "claimed", lease_expires_at: now },
    { status: "queued", lease_owner: "worker", lease_expires_at: now }, { status: "queued", lease_owner: "worker" } ];
  for (const state of refused) await expect(insertExecution(db, { occurrence_id, evidence_set_id, state })).rejects.toThrow();
}));

test("not-ready evidence can become ready, then all updates are refused; subject-question identity is unique", () => scratchGrading(async (db, occurrence_id) => {
  const id = await seedGradingRecords(db, occurrence_id, true);
  await withTenant(db, tenant, (trx) => trx.updateTable("observation.evidence_set")
    .set({ is_incomplete: false, incompleteness_reason: null, evidence_refs: sql`'[{"ref":"source","content":"captured"}]'::jsonb` })
    .where("evidence_set_id", "=", id).execute());
  await expect(withTenant(db, tenant, (trx) => trx.updateTable("observation.evidence_set").set({ evidence_refs: sql`'[]'::jsonb` })
    .where("evidence_set_id", "=", id).execute())).rejects.toThrow("ready evidence_set is immutable");
  await expect(withTenant(db, tenant, (trx) => trx.insertInto("observation.evidence_set").values({ ...tenant, evidence_set_id: "different-id",
    subject_occurrence_id: occurrence_id, question_id: "relevance", question_version: "1", evidence_refs: sql`'[]'::jsonb`,
    is_incomplete: true, incompleteness_reason: "not ready" }).execute())).rejects.toThrow("unique");
}));

test("provider attempts key on executions, and grade reads join subject, question and evaluator through execution", () => scratchGrading(async (db, occurrence_id) => {
  const evidence_set_id = await seedGradingRecords(db, occurrence_id);
  const execution = await insertExecution(db, { occurrence_id, evidence_set_id, state: { status: "completed", ended_at: new Date() } });
  const attempt = { ...tenant, execution_id: execution.execution_id, attempt: 1, run_id: "run-1", admitted_estimate: 0 };
  await withTenant(db, tenant, (trx) => trx.insertInto("observation.grading_provider_attempt").values(attempt).execute());
  await expect(withTenant(db, tenant, (trx) => trx.insertInto("observation.grading_provider_attempt").values(attempt).execute())).rejects.toThrow("unique");
  await expect(withTenant(db, tenant, (trx) => trx.insertInto("observation.grading_provider_attempt")
    .values({ ...attempt, execution_id: "absent" }).execute())).rejects.toThrow("foreign key");
  const grade = { ...tenant, observation_id: "grade-1", execution_id: execution.execution_id, answer_kind: "boolean", answer_state: "answered",
    answer_payload: sql<JsonValue>`'{"state":"answered","kind":"boolean","value":true}'::jsonb` };
  await withTenant(db, tenant, (trx) => trx.insertInto("observation.grade_observation").values(grade).execute());
  await expect(withTenant(db, tenant, (trx) => trx.insertInto("observation.grade_observation")
    .values({ ...grade, observation_id: "duplicate" }).execute())).rejects.toThrow("unique");
  await expect(withTenant(db, tenant, (trx) => trx.updateTable("observation.grade_observation")
    .set({ comments: "changed" }).execute())).rejects.toThrow("append-only");
  await expect(withTenant(db, tenant, (trx) => trx.deleteFrom("observation.grade_observation").execute())).rejects.toThrow("append-only");
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }] } });
  const response = await app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/grades`, { headers: { authorization: "Bearer read" } });
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: { total: 1,
    items: [{ observation: { execution_id: execution.execution_id }, execution: { subject_occurrence_id: occurrence_id,
      evidence_set_id, question_id: "relevance", question_version: "1", evaluator_definition_id: "human" }, evaluator: { kind: "human" } }] } });
}));
