import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { ArtifactRevisionId, EvidenceSetId, ItemOccurrenceId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import { evaluationDigest, submissionAttemptLabel, submissionDigest, type EvaluationIdentity } from "../src/grading/execution";
import type { GradeAnswer } from "../src/grading/observation";
import { OAKRIDGE_QUESTIONS, createFeed, evaluator, evaluatorId, fixtureBody, integration, scratchDatabase, tenant } from "./grading-fixture";
import { readOccurrenceEvidence, recordCollection } from "../src/storage/captured-evidence-store";
import type { CaptureConfiguration } from "../src/grading/evidence";
import { jsonText, withTenant, type Database, type TenantScope } from "../src/storage/database";
import { listGrades, registerEvaluator, registerQuestion } from "../src/storage/grading-store";
import { listRunItems } from "../src/storage/projection-store";

const relevance = OAKRIDGE_QUESTIONS[0]!;
const other_tenant: TenantScope = { producer: "oakridge", namespace: "other" };
const answer = (value: string): GradeAnswer => ({ state: "answered", kind: "choice", value });
const configuration: CaptureConfiguration = { pins: [{ ...relevance, evaluator_definition_ids: [evaluatorId("model"), evaluatorId("human")] }] };

interface Measured { readonly occurrence_id: ItemOccurrenceId; readonly evidence_set_id: EvidenceSetId }
/** A captured finding pinned to two evaluators, with ready evidence. */
async function readyFinding(db: Database, scope: TenantScope = tenant): Promise<Measured> {
  await registerQuestion(db, scope, relevance);
  await registerEvaluator(db, scope, evaluator("model"));
  await registerEvaluator(db, scope, evaluator("human"));
  await createFeed(db, scope, configuration).revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") });
  const items = await listRunItems(db, scope, "run-1", { limit: 50, offset: 0 });
  const occurrence_id = items.items.find((item) => item.item_kind === "finding")!.occurrence_id as ItemOccurrenceId;
  const [pinned] = await readOccurrenceEvidence(db, scope, occurrence_id);
  const ready = await recordCollection(db, scope, pinned!.evidence_set_id, { state: "ready",
    references: [{ source: "reported", reported_by: "agent", ref: "subject", revision_id: "revision-1" as ArtifactRevisionId, item_path: "/findings/0", content: "finding" }] });
  if (!ready.ok) throw new Error(ready.error.detail);
  return { occurrence_id, evidence_set_id: pinned!.evidence_set_id };
}

interface ExecutionInput { readonly attempt_label?: string; readonly status?: string; readonly evaluator_definition_id?: string; readonly scope?: TenantScope; readonly idempotency_digest?: string }
async function insertExecution(db: Database, measured: Measured, input: ExecutionInput = {}): Promise<string> {
  const scope = input.scope ?? tenant;
  const identity: EvaluationIdentity = { subject_occurrence_id: measured.occurrence_id, evidence_set_id: measured.evidence_set_id,
    question_id: relevance.question_id, question_version: relevance.question_version,
    evaluator_definition_id: evaluatorId(input.evaluator_definition_id ?? "human"), attempt_label: input.attempt_label ?? "first" };
  const digest = evaluationDigest(identity);
  if (!digest.ok) throw new Error(digest.error.detail);
  const status = input.status ?? "completed";
  const execution_id = randomUUID();
  await withTenant(db, scope, (trx) => trx.insertInto("observation.evaluation_execution").values({ ...scope, ...identity, execution_id, run_id: "run-1",
    idempotency_digest: input.idempotency_digest ?? digest.value, status, lease_owner: null, lease_expires_at: null, terminal_cause: null, started_at: null,
    ended_at: status === "completed" ? new Date() : null, error: null, model_usage: null, cost: null, external_execution_id: null,
    provider_link: null, reproducibility_metadata: null }).execute());
  return execution_id;
}
interface ObservationInput { readonly reviewer_id?: string | null; readonly supersedes?: string; readonly value?: string; readonly scope?: TenantScope }
async function insertObservation(db: Database, execution_id: string, input: ObservationInput = {}): Promise<string> {
  const scope = input.scope ?? tenant;
  const observation_id = randomUUID();
  const payload = answer(input.value ?? "relevant");
  await withTenant(db, scope, (trx) => trx.insertInto("observation.grade_observation").values({ ...scope, observation_id, execution_id,
    answer_kind: payload.kind, answer_state: payload.state, answer_payload: jsonText(payload as JsonValue), probabilities: null,
    confidence: null, reviewer_id: input.reviewer_id === undefined ? "reviewer-1" : input.reviewer_id, reviewer_details: null,
    comments: null, rationale: null, supersedes_observation_id: input.supersedes ?? null }).execute());
  return observation_id;
}

test("a submission's identity is its reviewer and id, so a reused id cannot become a second answer", () => {
  const digest = (reviewer_id: string, submission_id: string): string => {
    const result = submissionDigest({ reviewer_id, submission_id });
    if (!result.ok) throw new Error(result.error.detail);
    return result.value;
  };
  expect(digest("reviewer-1", "s1")).toBe(digest("reviewer-1", "s1"));
  expect(digest("reviewer-1", "s1")).not.toBe(digest("reviewer-2", "s1"));
  expect(submissionAttemptLabel({ reviewer_id: "reviewer-1", submission_id: "s1" })).toBe("submission:s1");
});

integration("an answer reads its measurement through its execution", async () => scratchDatabase(async (db) => {
  const measured = await readyFinding(db);
  const observation_id = await insertObservation(db, await insertExecution(db, measured));
  const grades = await listGrades(db, tenant, measured.occurrence_id, { limit: 10, offset: 0 });
  expect(grades?.total).toBe(1);
  expect(grades?.items[0]).toMatchObject({ observation: { observation_id, reviewer_id: "reviewer-1" }, answer: answer("relevant"),
    execution: { subject_occurrence_id: measured.occurrence_id, evidence_set_id: measured.evidence_set_id, question_id: relevance.question_id,
      question_version: relevance.question_version, evaluator_definition_id: "human", status: "completed" },
    evaluator: { evaluator_definition_id: "human", kind: "human" } });
  expect(Object.keys(grades?.items[0]?.observation ?? {})).not.toContain("subject_occurrence_id");
}));

integration("a correction appends, keeps the earlier answer and evidence, and joins to the same measurement", async () => scratchDatabase(async (db) => {
  const measured = await readyFinding(db);
  const first = await insertObservation(db, await insertExecution(db, measured));
  const before = await readOccurrenceEvidence(db, tenant, measured.occurrence_id);
  const correction = await insertObservation(db, await insertExecution(db, measured, { attempt_label: "correction" }),
    { supersedes: first, value: "irrelevant" });
  const grades = await listGrades(db, tenant, measured.occurrence_id, { limit: 10, offset: 0 });
  const history = grades?.items.map(({ answer: given, observation }) => [String(observation.observation_id), given,
    observation.supersedes_observation_id === null ? null : String(observation.supersedes_observation_id)]);
  expect(history).toContainEqual([first, answer("relevant"), null]);
  expect(history).toContainEqual([correction, answer("irrelevant"), first]);
  expect(await readOccurrenceEvidence(db, tenant, measured.occurrence_id)).toEqual(before);
}));

integration("a correction of another measurement, reviewer or tenant is refused", async () => scratchDatabase(async (db) => {
  const measured = await readyFinding(db);
  const first = await insertObservation(db, await insertExecution(db, measured));
  await expect(insertObservation(db, await insertExecution(db, measured, { attempt_label: "other-reviewer" }),
    { supersedes: first, reviewer_id: "reviewer-2" })).rejects.toThrow("same measurement and reviewer");
  const elsewhere = await readyFinding(db, other_tenant);
  const foreign = await insertExecution(db, elsewhere, { scope: other_tenant });
  await expect(insertObservation(db, foreign, { scope: other_tenant, supersedes: first })).rejects.toThrow();
  await expect(insertObservation(db, foreign)).rejects.toThrow("completed execution");
}));

integration("a machine answer has no reviewer and cannot be corrected; a human answer requires one", async () => scratchDatabase(async (db) => {
  const measured = await readyFinding(db);
  const machine = await insertExecution(db, measured, { evaluator_definition_id: "model" });
  await expect(insertObservation(db, machine, { reviewer_id: "reviewer-1" })).rejects.toThrow("reviewer must match");
  const answered = await insertObservation(db, machine, { reviewer_id: null });
  const repeat = await insertExecution(db, measured, { evaluator_definition_id: "model", attempt_label: "repeat" });
  await expect(insertObservation(db, repeat, { reviewer_id: null, supersedes: answered })).rejects.toThrow("only a reviewer answer");
  await expect(insertObservation(db, await insertExecution(db, measured, { attempt_label: "anonymous" }), { reviewer_id: null }))
    .rejects.toThrow("reviewer must match");
}));

integration("correction history is linear and one execution holds one answer", async () => scratchDatabase(async (db) => {
  const measured = await readyFinding(db);
  const execution = await insertExecution(db, measured);
  const first = await insertObservation(db, execution);
  await expect(insertObservation(db, execution, { supersedes: first })).rejects.toThrow("duplicate key");
  await insertObservation(db, await insertExecution(db, measured, { attempt_label: "second" }), { supersedes: first });
  await expect(insertObservation(db, await insertExecution(db, measured, { attempt_label: "fork" }), { supersedes: first })).rejects.toThrow("duplicate key");
}));

integration("answers and captured sources refuse every update and delete, with no exception", async () => scratchDatabase(async (db) => {
  const measured = await readyFinding(db);
  const observation_id = await insertObservation(db, await insertExecution(db, measured));
  const statements = [
    ["UPDATE observation.grade_observation SET comments = 'rewritten'", "grade_observation is append-only"],
    ["DELETE FROM observation.grade_observation", "grade_observation is append-only"],
    ["UPDATE observation.source_revision SET unit_id = 'moved'", "source_revision is append-only"],
    ["DELETE FROM observation.item_relation; DELETE FROM observation.source_revision", "source_revision is append-only"],
    ["UPDATE observation.item_occurrence SET item_kind = 'moved'", "item_occurrence is append-only"],
    ["UPDATE observation.question_definition SET question_text = 'reworded'", "question_definition is append-only"],
    ["DELETE FROM observation.evaluator_definition", "evaluator_definition is append-only"],
    ["DELETE FROM observation.evidence_set", "evidence_set is never removed"],
    ["DELETE FROM observation.evaluation_execution", "evaluation_execution is never removed"],
    ["UPDATE observation.evaluation_execution SET status = 'queued', ended_at = NULL", "ended evaluation_execution is immutable"],
  ] as const;
  for (const [statement, refusal] of statements)
    await expect(withTenant(db, tenant, async (trx) => { await sql.raw(statement).execute(trx); })).rejects.toThrow(refusal);
  const stored = await listGrades(db, tenant, measured.occurrence_id, { limit: 10, offset: 0 });
  expect(stored?.items.map((item) => String(item.observation.observation_id))).toEqual([observation_id]);
}));

integration("an answer needs a completed execution of the matching response kind", async () => scratchDatabase(async (db) => {
  const measured = await readyFinding(db);
  const queued = await insertExecution(db, measured, { status: "queued", evaluator_definition_id: "model" });
  await expect(insertObservation(db, queued, { reviewer_id: null })).rejects.toThrow("requires a completed execution");
  const completed = await insertExecution(db, measured, { attempt_label: "wrong-kind" });
  await expect(withTenant(db, tenant, (trx) => trx.insertInto("observation.grade_observation").values({ ...tenant, observation_id: randomUUID(),
    execution_id: completed, answer_kind: "boolean", answer_state: "answered", answer_payload: jsonText({ state: "answered", kind: "boolean", value: true }),
    probabilities: null, confidence: null, reviewer_id: "reviewer-1", reviewer_details: null, comments: null, rationale: null,
    supersedes_observation_id: null }).execute())).rejects.toThrow("answer kind differs");
}));

integration("an execution measures ready evidence with a pinned evaluator, in its own run and tenant", async () => scratchDatabase(async (db) => {
  const measured = await readyFinding(db);
  await registerEvaluator(db, tenant, evaluator("model", "unpinned"));
  await expect(insertExecution(db, measured, { evaluator_definition_id: "unpinned" })).rejects.toThrow("pinned evaluator");
  const elsewhere = await readyFinding(db, other_tenant);
  await expect(insertExecution(db, { occurrence_id: measured.occurrence_id, evidence_set_id: elsewhere.evidence_set_id }))
    .rejects.toThrow();
  const execution_id = await insertExecution(db, measured);
  await expect(withTenant(db, tenant, (trx) => trx.updateTable("observation.evaluation_execution").set({ retries: 1 })
    .where("execution_id", "=", execution_id).execute())).rejects.toThrow("immutable");
  const queued = await insertExecution(db, measured, { status: "queued", attempt_label: "queued", evaluator_definition_id: "model" });
  await expect(withTenant(db, tenant, (trx) => trx.updateTable("observation.evaluation_execution").set({ evaluator_definition_id: "human" })
    .where("execution_id", "=", queued).execute())).rejects.toThrow("identity is immutable");
}));

integration("a provider attempt references its execution and run, apart from the measurement", async () => scratchDatabase(async (db) => {
  const measured = await readyFinding(db);
  const execution_id = await insertExecution(db, measured, { status: "queued", evaluator_definition_id: "model" });
  const attempt = { ...tenant, execution_id, attempt: 1, admitted_estimate: 0.01, outcome: null, provider_request_id: null, failure_category: null };
  await expect(withTenant(db, tenant, (trx) => trx.insertInto("observation.grading_provider_attempt").values({ ...attempt, run_id: "another-run" }).execute()))
    .rejects.toThrow("foreign key");
  await withTenant(db, tenant, (trx) => trx.insertInto("observation.grading_provider_attempt").values({ ...attempt, run_id: "run-1" }).execute());
  const stored = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.grading_provider_attempt").selectAll().execute());
  expect(stored).toMatchObject([{ execution_id, attempt: 1, run_id: "run-1", request_sent: false, charged_cost: 0 }]);
}));

integration("a lease exists exactly while an execution is claimed, and the digest stays unique", async () => scratchDatabase(async (db) => {
  const measured = await readyFinding(db);
  const execution_id = await insertExecution(db, measured, { status: "queued", evaluator_definition_id: "model" });
  const update = (values: { status: string; lease_owner: string | null; lease_expires_at: Date | null }) =>
    withTenant(db, tenant, (trx) => trx.updateTable("observation.evaluation_execution").set(values).where("execution_id", "=", execution_id).execute());
  await expect(update({ status: "claimed", lease_owner: null, lease_expires_at: null })).rejects.toThrow("check constraint");
  await expect(update({ status: "queued", lease_owner: "worker", lease_expires_at: new Date() })).rejects.toThrow("check constraint");
  await update({ status: "claimed", lease_owner: "worker", lease_expires_at: new Date(Date.now() + 1000) });
  await expect(insertExecution(db, measured, { status: "queued", evaluator_definition_id: "model" })).rejects.toThrow("duplicate key");
}));
