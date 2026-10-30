import { expect, test } from "bun:test";
import { sql } from "kysely";
import { createApp } from "../src/http/app";
import { withTenant } from "../src/storage/database";
import { listGrades, registerGradingContext, runGrade } from "../src/storage/grading-store";
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
    grade: [{ ...tenant, token: "blind", reviewer_id: "reviewer-a" }] } });
  const headers = { authorization: "Bearer blind", "content-type": "application/json" };
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
  const submitted = await app.request("/v1/grades", { method: "POST", headers, body: JSON.stringify({
    identity: { ...identity, evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "blind" },
    context: { question, evidence, evaluator: evaluator("human") }, details: {
      answer: { state: "answered", kind: "boolean", value: false }, collection_mode: "blind",
      blind_assignment_id: assignment_id, model_answers_visible: false, workflow_decisions_visible: false,
    },
  }) });
  expect(submitted.status).toBe(422);
}));

integration("a claimed blind assignment submits one append-only native grade", async () => scratchGrading(async (db, occurrence_id) => {
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
  const grades = await app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/grades`,
    { headers: { authorization: "Bearer read" } });
  expect((await grades.json()).items[0].observation).toMatchObject({ observation_id, collection_mode: "blind",
    blind_assignment_id: assignment_id, model_answers_visible: false, workflow_decisions_visible: false });
  await expect(withTenant(db, tenant, (trx) => sql`UPDATE observation.grade_observation SET comments = 'changed'
    WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} AND observation_id = ${observation_id}`.execute(trx)))
    .rejects.toThrow("grade_observation is append-only");
}));
