import { expect, test } from "bun:test";
import { sql } from "kysely";
import { createApp } from "../src/http/app";
import { storeHumanGradeInTransaction } from "../src/storage/backfill-store";
import { claimBlindAssignment, createBlindAssignment } from "../src/storage/blind-assignment-store";
import { withTenant } from "../src/storage/database";
import { listGrades, registerGradingContext, runGrade } from "../src/storage/grading-store";
import { readCoverage } from "../src/storage/coverage-store";
import { question, evidence, evaluator, scratchGrading, tenant } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;

integration("blind assignment hides model results and refuses duplicate or expired claims", async () => scratchGrading(async (db, occurrence_id) => {
  const model = evaluator("model");
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: model })).ok).toBe(true);
  const scored = await runGrade(db, tenant, { identity: { subject_occurrence_id: occurrence_id,
    evidence_set_id: evidence.evidence_set_id, question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: model.evaluator_definition_id, config_digest: model.config_digest, attempt_label: "model" },
    runner: { kind: "model", run: async () => ({ ok: true, value: {
      answer: { state: "answered", kind: "boolean", value: true } } }) } });
  expect(scored.ok && scored.value.observation).toBeTruthy();
  expect((await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 }))?.items[0]?.observation.collection_mode).toBe("unknown");
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
  const created = await app.request("/v1/blind-assignments", { method: "POST", headers, body: JSON.stringify(identity) });
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
      answer: { state: "answered", kind: "boolean", value: false }, collection_mode: "blind",
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
      answer: { state: "answered", kind: "boolean", value: false }, collection_mode: "blind",
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
      answer: { state: "answered", kind: "boolean", value: true }, collection_mode: "blind",
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

integration("readback distinguishes blind, in-context, correction and historical operator grades", async () => scratchGrading(async (db, occurrence_id) => {
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
  const created = await app.request("/v1/blind-assignments", { method: "POST", headers, body: JSON.stringify(identity) });
  const assignment_id = (await created.json()).assignment_id as string;
  expect((await app.request(`/v1/blind-assignments/${assignment_id}/claim`, { method: "POST", headers })).status).toBe(200);
  const submitted = await app.request("/v1/grades", { method: "POST", headers, body: JSON.stringify({
    identity: { ...identity, evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "blind" },
    context: { question, evidence, evaluator: evaluator("human") }, details: {
      answer: { state: "answered", kind: "boolean", value: false }, collection_mode: "blind",
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
      collection_mode: "in_context", model_answers_visible: true, workflow_decisions_visible: false } };
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
    format: "observation.source-event/v1", definition_bundle: null, artifact_schema_version: null,
    kind: "human_grade", event_kind: "operator_decided", run_id: "run-1", event_id: "event-four-kinds",
    decision_id: "decision-four-kinds", evaluator: { kind: "human" }, unit: "unit-1", review: "assessment",
    decision: "approve", target: "rev-1", feedback: { reason: "approved" }, effect: "approve",
    decided_at: "2026-10-29T10:00:00.000Z",
  }));
  const grades = await app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/grades`,
    { headers: { authorization: "Bearer read" } });
  const items = (await grades.json()).items as { observation: { observation_id: string; collection_mode: string;
    label_origin: string; supersedes_observation_id: string | null; reviewer_id: string } }[];
  expect(items).toHaveLength(4);
  expect(items.find((item) => item.observation.observation_id === observation_id)?.observation).toMatchObject({
    observation_id, collection_mode: "blind",
    blind_assignment_id: assignment_id, model_answers_visible: false, workflow_decisions_visible: false });
  expect(items.find((item) => item.observation.observation_id === inContextId)?.observation.collection_mode).toBe("in_context");
  expect(items.find((item) => item.observation.observation_id === correctionId)?.observation)
    .toMatchObject({ collection_mode: "in_context", supersedes_observation_id: inContextId });
  expect(items.find((item) => item.observation.label_origin === "oakridge_operator_unblinded")?.observation)
    .toMatchObject({ collection_mode: "unknown", reviewer_id: "oakridge-operator" });
  const coverage = await readCoverage(db, tenant, { run_id: "run-1", revision_id: "rev-1",
    question_id: question.question_id, question_version: question.question_version });
  expect(coverage.questions[0]).toMatchObject({ eligible: 1, graded: 1,
    graded_by_collection_mode: { blind: 1, in_context: 1, unknown: 0 } });
  await expect(withTenant(db, tenant, (trx) => sql`UPDATE observation.grade_observation SET comments = 'changed'
    WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND observation_id = ${observation_id}`.execute(trx)))
    .rejects.toThrow("grade_observation is append-only");
}));
