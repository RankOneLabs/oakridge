import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createApp } from "../src/http/app";
import { storeHumanGradeInTransaction } from "../src/storage/backfill-store";
import { claimBlindAssignment, createBlindAssignment } from "../src/storage/blind-assignment-store";
import { evaluationDigest } from "../src/grading/execution";
import { jsonText, withTenant } from "../src/storage/database";
import { listGrades, recordHumanGrade, registerGradingContext, runGrade } from "../src/storage/grading-store";
import { readCoverage } from "../src/storage/coverage-store";
import { question, evidence, evaluator, scratchGrading, tenant, humanGradeDetails, capturedCoverage } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;

integration("blind assignment hides model results and refuses duplicate or expired claims", async () => scratchGrading(async (db) => {
  const { occurrence_id, question, evidence } = await capturedCoverage(db);
  const model = evaluator("model");
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: model })).ok).toBe(true);
  const scored = await runGrade(db, tenant, { identity: { subject_occurrence_id: occurrence_id,
    evidence_set_id: evidence.evidence_set_id, question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: model.evaluator_definition_id, config_digest: model.config_digest, attempt_label: "model" },
    runner: { kind: "model", run: async () => ({ ok: true, value: {
      answer: { state: "answered", kind: "boolean", value: true } } }) } });
  expect(scored.ok && scored.value.observation).toBeTruthy();
  expect((await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 }))?.items[0]?.observation.collection_mode).toBe("in_context");
  await withTenant(db, tenant, (trx) => sql`INSERT INTO observation.evaluation_eligibility
    (producer, namespace, subject_occurrence_id, question_id, question_version, tag, payload)
    VALUES (${tenant.producer}, ${tenant.namespace}, ${occurrence_id}, ${question.question_id}, ${question.question_version},
      'eligible', ${JSON.stringify({ evidence_set_id: evidence.evidence_set_id })}::jsonb)`.execute(trx));
  const app = createApp({ db, credentials: { ingest: [], read: [],
    grade: [{ ...tenant, token: "blind", reviewer_id: "reviewer-a" },
      { ...tenant, token: "recovery", reviewer_id: "reviewer-b" }] } });
  const headers = { authorization: "Bearer blind", "content-type": "application/json" };
  const recoveryHeaders = { authorization: "Bearer recovery", "content-type": "application/json" };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version };
  const created = await app.request("/v1/blind-assignments", { method: "POST", headers, body: JSON.stringify({ subject_occurrence_id: identity.subject_occurrence_id, question_id: identity.question_id, question_version: identity.question_version }) });
  expect(created.status).toBe(201);
  const assignment_id = (await created.json()).assignment_id as string;
  const queue = await app.request("/v1/blind-assignments?limit=10", { headers });
  expect((await queue.json()).items[0].assignment_id).toBe(assignment_id);
  const before = await app.request(`/v1/blind-assignments/${assignment_id}`, { headers });
  expect((await before.json()).state).toBe("unsubmitted");
  const claim = await app.request(`/v1/blind-assignments/${assignment_id}/claim`, { method: "POST", headers });
  expect(claim.status).toBe(200);
  expect((await app.request(`/v1/blind-assignments/${assignment_id}/claim`, { method: "POST", headers })).status).toBe(409);
  const read = await app.request(`/v1/blind-assignments/${assignment_id}`, { headers });
  const payload = await read.json();
  expect(payload.state).toBe("claimed");
  expect(JSON.stringify(payload)).not.toMatch(/model.grade|agreement|approval|answer_payload|normalized_score/);
  await withTenant(db, tenant, (trx) => sql`UPDATE observation.blind_assignment SET expires_at = claimed_at + interval '1 microsecond'
    WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND assignment_id = ${assignment_id}`.execute(trx));
  const expired = await app.request(`/v1/blind-assignments/${assignment_id}`, { headers });
  expect((await expired.json()).state).toBe("expired");
  const recoveryQueue = await app.request("/v1/blind-assignments?limit=10", { headers });
  expect((await recoveryQueue.json()).items[0]).toMatchObject({ assignment_id, state: "expired" });
  const submitted = await app.request("/v1/grades", { method: "POST", headers, body: JSON.stringify({
    identity: { ...identity, evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "blind" },
    context: { question, evidence, evaluator: evaluator("human") }, details: {
      answer: { state: "answered", kind: "boolean", value: false }, origin: "human_rubric_answer", collection_mode: "blind",
      blind_assignment_id: assignment_id, model_answers_visible: false, workflow_decisions_visible: false,
    },
  }) });
  expect(submitted.status).toBe(422);
  const recovered = await app.request(`/v1/blind-assignments/${assignment_id}/claim`,
    { method: "POST", headers: recoveryHeaders });
  expect(recovered.status).toBe(200);
  expect((await recovered.json())).toMatchObject({ state: "claimed", claim_owner: "reviewer-b" });
  expect((await app.request(`/v1/blind-assignments/${assignment_id}`, { headers })).status).toBe(404);
  const retry = await app.request("/v1/grades", { method: "POST", headers: recoveryHeaders, body: JSON.stringify({
    identity: { ...identity, evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "blind" },
    context: { question, evidence, evaluator: evaluator("human") }, details: {
      answer: { state: "answered", kind: "boolean", value: false }, origin: "human_rubric_answer", collection_mode: "blind",
      blind_assignment_id: assignment_id, model_answers_visible: false, workflow_decisions_visible: false,
    },
  }) });
  expect(retry.status).toBe(201);
  expect((await app.request(`/v1/blind-assignments/${assignment_id}/claim`, { method: "POST", headers })).status).toBe(409);
}));

integration("overlapping blind submissions replay the saved grade", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  await withTenant(db, tenant, (trx) => sql`INSERT INTO observation.evaluation_eligibility
    (producer, namespace, subject_occurrence_id, question_id, question_version, tag, payload)
    VALUES (${tenant.producer}, ${tenant.namespace}, ${occurrence_id}, ${question.question_id}, ${question.question_version},
      'eligible', ${JSON.stringify({ evidence_set_id: evidence.evidence_set_id })}::jsonb)`.execute(trx));
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version };
  const assignment = await createBlindAssignment(db, tenant, identity);
  if (!assignment.ok) throw new Error(assignment.error.detail);
  expect((await claimBlindAssignment(db, tenant, { assignment_id: assignment.value.assignment_id,
    reviewer_id: "reviewer-a", duration_seconds: 900 })).ok).toBe(true);
  const app = createApp({ db, credentials: { ingest: [], read: [],
    grade: [{ ...tenant, token: "blind", reviewer_id: "reviewer-a" }] } });
  const request = { method: "POST", headers: { authorization: "Bearer blind", "content-type": "application/json" },
    body: JSON.stringify({ identity: { ...identity, evaluator_definition_id: "human",
      config_digest: "config-1", attempt_label: "overlap" }, details: {
      answer: { state: "answered", kind: "boolean", value: true }, origin: "human_rubric_answer", collection_mode: "blind",
      blind_assignment_id: assignment.value.assignment_id,
      model_answers_visible: false, workflow_decisions_visible: false } }) };
  const pending: Promise<Response>[] = [];
  const completed = [false, false];
  await withTenant(db, tenant, async (trx) => {
    await trx.selectFrom("observation.blind_assignment").select("assignment_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("assignment_id", "=", assignment.value.assignment_id).forUpdate().executeTakeFirstOrThrow();
    pending.push(...completed.map((_, index) => Promise.resolve(app.request("/v1/grades", request))
      .finally(() => { completed[index] = true; })));
    await Bun.sleep(150);
    expect(completed).toEqual([false, false]);
  });
  const [first, second] = await Promise.all(pending);
  expect([first.status, second.status].sort()).toEqual([200, 201]);
  const [firstGrade, secondGrade] = await Promise.all([first.json(), second.json()]);
  expect(firstGrade.observation.observation_id).toBe(secondGrade.observation.observation_id);
}));

integration("readback distinguishes blind, in-context, correction and historical operator grades", async () => scratchGrading(async (db) => {
  const { occurrence_id, question, evidence } = await capturedCoverage(db);
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  await withTenant(db, tenant, (trx) => sql`INSERT INTO observation.evaluation_eligibility
    (producer, namespace, subject_occurrence_id, question_id, question_version, tag, payload)
    VALUES (${tenant.producer}, ${tenant.namespace}, ${occurrence_id}, ${question.question_id}, ${question.question_version},
      'eligible', ${JSON.stringify({ evidence_set_id: evidence.evidence_set_id })}::jsonb)`.execute(trx));
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }],
    grade: [{ ...tenant, token: "blind", reviewer_id: "reviewer-a" }] } });
  const headers = { authorization: "Bearer blind", "content-type": "application/json" };
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version };
  const created = await app.request("/v1/blind-assignments", { method: "POST", headers, body: JSON.stringify({ subject_occurrence_id: identity.subject_occurrence_id, question_id: identity.question_id, question_version: identity.question_version }) });
  const assignment_id = (await created.json()).assignment_id as string;
  expect((await app.request(`/v1/blind-assignments/${assignment_id}/claim`, { method: "POST", headers })).status).toBe(200);
  const submitted = await app.request("/v1/grades", { method: "POST", headers, body: JSON.stringify({
    identity: { ...identity, evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "blind" },
    context: { question, evidence, evaluator: evaluator("human") }, details: {
      answer: { state: "answered", kind: "boolean", value: false }, origin: "human_rubric_answer", collection_mode: "blind",
      blind_assignment_id: assignment_id, model_answers_visible: false, workflow_decisions_visible: false,
    },
  }) });
  expect(submitted.status).toBe(201);
  const observation_id = (await submitted.json()).observation.observation_id as string;
  const assignment = await app.request(`/v1/blind-assignments/${assignment_id}`, { headers });
  expect((await assignment.json()).state).toBe("submitted");
  const inContextRequest = { identity: { ...identity, evaluator_definition_id: "human",
    config_digest: "config-1", attempt_label: "in-context" },
    details: { answer: { state: "answered", kind: "boolean", value: true },
      origin: "human_rubric_answer" as const, collection_mode: "in_context", model_answers_visible: true, workflow_decisions_visible: false } };
  const inContext = await app.request("/v1/grades", { method: "POST", headers,
    body: JSON.stringify(inContextRequest) });
  expect(inContext.status).toBe(201);
  const inContextId = (await inContext.json()).observation.observation_id as string;
  const correction = await app.request("/v1/grades", { method: "POST", headers,
    body: JSON.stringify({ ...inContextRequest,
      identity: { ...inContextRequest.identity, attempt_label: "correction" },
      details: { ...inContextRequest.details, answer: { state: "answered", kind: "boolean", value: false },
        supersedes_observation_id: inContextId } }) });
  expect(correction.status).toBe(201);
  const correctionId = (await correction.json()).observation.observation_id as string;
  await withTenant(db, tenant, (trx) => storeHumanGradeInTransaction(trx, tenant, {
    format: "observation.source-event/v1", definition_id: null, artifact_schema_version: null,
    kind: "human_grade", event_kind: "operator_decided", run_id: "run-1", event_id: "event-four-kinds",
    decision_id: "decision-four-kinds", evaluator: { kind: "human" }, unit: "unit-1", review: "assessment",
    decision: "approve", target: "captured-brief", feedback: { reason: "approved" }, effect: "approve",
    decided_at: "2026-10-29T10:00:00.000Z",
  }));
  const grades = await app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/grades`,
    { headers: { authorization: "Bearer read" } });
  const items = (await grades.json()).items as { observation: { observation_id: string; collection_mode: string;
    origin: string; supersedes_observation_id: string | null; reviewer_id: string } }[];
  expect(items).toHaveLength(4);
  expect(items.find((item) => item.observation.observation_id === observation_id)?.observation).toMatchObject({
    observation_id, collection_mode: "blind",
    blind_assignment_id: assignment_id, model_answers_visible: false, workflow_decisions_visible: false });
  expect(items.find((item) => item.observation.observation_id === inContextId)?.observation.collection_mode).toBe("in_context");
  expect(items.find((item) => item.observation.observation_id === correctionId)?.observation)
    .toMatchObject({ collection_mode: "in_context", supersedes_observation_id: inContextId });
  expect(items.find((item) => item.observation.origin === "workflow_approval")?.observation)
    .toMatchObject({ collection_mode: "in_context", reviewer_id: "oakridge-operator" });
  const coverage = await readCoverage(db, tenant, { run_id: "run-1", revision_id: "captured-brief",
    question_id: question.question_id, question_version: question.question_version });
  expect(coverage.questions[0]).toMatchObject({ eligible: 1, graded: 1,
    graded_by_collection_mode: { blind: 1, in_context: 1 } });
  await expect(withTenant(db, tenant, (trx) => sql`UPDATE observation.grade_observation SET comments = 'changed'
    WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND observation_id = ${observation_id}`.execute(trx)))
    .rejects.toThrow("grade_observation is append-only");
}));

interface GradeConstraintInput {
  readonly origin: string | null | undefined;
  readonly collection_mode: "blind" | "in_context" | null | undefined;
  readonly blind_assignment_id: string | null;
  readonly model_answers_visible: boolean | null;
  readonly workflow_decisions_visible: boolean | null;
}
type GradeConstraintError =
  | { readonly code: "23502"; readonly column: "origin" | "collection_mode" }
  | { readonly code: "23514" | "23503"; readonly constraint: string };
interface GradeConstraintCase {
  readonly description: string;
  readonly row: GradeConstraintInput;
  readonly error: GradeConstraintError;
}
const in_context: GradeConstraintInput = { origin: "human_rubric_answer", collection_mode: "in_context",
  blind_assignment_id: null, model_answers_visible: false, workflow_decisions_visible: false };
const blind: GradeConstraintInput = { ...in_context, collection_mode: "blind", blind_assignment_id: "valid-assignment" };
const constraint_cases: readonly GradeConstraintCase[] = [
  { description: "omitted origin", row: { ...in_context, origin: undefined }, error: { code: "23502", column: "origin" } },
  { description: "null origin", row: { ...in_context, origin: null }, error: { code: "23502", column: "origin" } },
  { description: "catch-all origin", row: { ...in_context, origin: "other" },
    error: { code: "23514", constraint: "grade_observation_origin_check" } },
  { description: "unknown origin", row: { ...in_context, origin: "unknown" },
    error: { code: "23514", constraint: "grade_observation_origin_check" } },
  { description: "omitted collection mode", row: { ...in_context, collection_mode: undefined },
    error: { code: "23502", column: "collection_mode" } },
  { description: "null collection mode", row: { ...in_context, collection_mode: null },
    error: { code: "23502", column: "collection_mode" } },
  { description: "blind grade with no assignment", row: { ...blind, blind_assignment_id: null },
    error: { code: "23514", constraint: "grade_collection_consistency" } },
  { description: "blind grade with visible model answers", row: { ...blind, model_answers_visible: true },
    error: { code: "23514", constraint: "grade_collection_consistency" } },
  { description: "blind grade with null model visibility", row: { ...blind, model_answers_visible: null },
    error: { code: "23514", constraint: "grade_collection_consistency" } },
  { description: "blind grade with visible workflow decisions", row: { ...blind, workflow_decisions_visible: true },
    error: { code: "23514", constraint: "grade_collection_consistency" } },
  { description: "blind grade with null workflow visibility", row: { ...blind, workflow_decisions_visible: null },
    error: { code: "23514", constraint: "grade_collection_consistency" } },
  { description: "blind grade with nonexistent assignment", row: { ...blind, blind_assignment_id: "missing-assignment" },
    error: { code: "23503", constraint: "grade_blind_assignment_ref" } },
];
for (const { description, row, error } of constraint_cases) {
  integration(`database rejects ${description}`, async () => scratchGrading(async (db, occurrence_id) => {
    expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
    const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version };
    const recorded = await recordHumanGrade(db, tenant, { ...identity, evaluator_definition_id: "human",
      config_digest: "config-1", attempt_label: "valid-source", details: humanGradeDetails("human_rubric_answer") });
    if (!recorded.ok || !recorded.value.observation) throw new Error("missing valid source grade");
    const execution_id = randomUUID();
    const digest = evaluationDigest({ ...identity, evaluator_definition_id: "human",
      config_digest: "config-1", attempt_label: description });
    if (!digest.ok) throw new Error(digest.error.detail);
    await withTenant(db, tenant, async (trx) => {
      await trx.insertInto("observation.evaluation_execution").values({ ...recorded.value.execution,
        execution_id, idempotency_digest: digest.value, attempt_label: description,
        provider_attempts: jsonText(recorded.value.execution.provider_attempts) }).execute();
      await trx.insertInto("observation.blind_assignment").values({ ...tenant, ...identity,
        assignment_id: "valid-assignment", claim_owner: null, claimed_at: null,
        expires_at: null, submitted_observation_id: null }).execute();
    });
    // Omit columns entirely to prove PostgreSQL refuses them rather than applying a default.
    await expect(withTenant(db, tenant, (trx) => sql`INSERT INTO observation.grade_observation
      (producer, namespace, observation_id, execution_id, subject_occurrence_id, evidence_set_id,
       question_id, question_version, evaluator_definition_id, answer_kind, answer_state, answer_payload,
       ${row.origin === undefined ? sql`` : sql`origin,`}
       ${row.collection_mode === undefined ? sql`` : sql`collection_mode,`}
       blind_assignment_id, model_answers_visible, workflow_decisions_visible)
      SELECT producer, namespace, ${randomUUID()}, ${execution_id}, subject_occurrence_id, evidence_set_id,
       question_id, question_version, evaluator_definition_id, answer_kind, answer_state, answer_payload,
       ${row.origin === undefined ? sql`` : sql`${row.origin},`}
       ${row.collection_mode === undefined ? sql`` : sql`${row.collection_mode},`}
       ${row.blind_assignment_id}, ${row.model_answers_visible}, ${row.workflow_decisions_visible}
      FROM observation.grade_observation WHERE observation_id = ${recorded.value.observation!.observation_id}`.execute(trx)))
      .rejects.toMatchObject(error);
  }));
}
