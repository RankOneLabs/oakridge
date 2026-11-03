import { expect, test } from "bun:test";
import { listGrades, recordHumanGrade, registerGradingContext } from "../src/storage/grading-store";
import { readCoverage } from "../src/storage/coverage-store";
import { withTenant } from "../src/storage/database";
import { createApp } from "../src/http/app";
import { boundReviewer, credentialsFromEnv } from "../src/http/ingest-auth";
import { question, evidence, evaluator, scratchGrading, tenant, humanGradeDetails } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;

test("grade credentials require an explicit reviewer binding in configuration", () => {
  expect(() => credentialsFromEnv({ OBSERVATION_GRADE_CREDENTIALS: JSON.stringify([
    { ...tenant, token: "grade" },
  ]) } as NodeJS.ProcessEnv)).toThrow("reviewer_id binding");
  expect(boundReviewer({ ...tenant, token: "operator", reviewer_id: "oakridge-operator" })).toBe("oakridge-operator");
});

integration("grade route rejects a forged reviewer and stores the credential-bound reviewer", async () => scratchGrading(async (db, occurrence_id) => {
  const app = createApp({ db, credentials: { ingest: [], read: [],
    grade: [{ ...tenant, token: "grade", reviewer_id: "bound-reviewer" }] } });
  const request = { identity: { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "one" },
    context: { question, evidence, evaluator: evaluator("human") },
    details: { answer: { state: "answered", kind: "boolean", value: true },
      origin: "human_rubric_answer" as const, collection_mode: "in_context", model_answers_visible: false, workflow_decisions_visible: false } };
  const headers = { authorization: "Bearer grade", "content-type": "application/json" };
  const forged = await app.request("/v1/grades", { method: "POST", headers,
    body: JSON.stringify({ ...request, details: { ...request.details, reviewer_id: "other-reviewer" } }) });
  expect(forged.status).toBe(403);
  const accepted = await app.request("/v1/grades", { method: "POST", headers, body: JSON.stringify(request) });
  expect(accepted.status).toBe(201);
  expect((await accepted.json()).observation.reviewer_id).toBe("bound-reviewer");
}));

integration("recorded origin distinguishes a rubric answer from an approval sharing every identity", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "human", config_digest: "config-1" };
  await withTenant(db, tenant, (trx) => trx.insertInto("observation.evaluation_eligibility").values({ ...tenant,
    subject_occurrence_id: occurrence_id, question_id: question.question_id, question_version: question.question_version,
    tag: "eligible", payload: { evidence_set_id: evidence.evidence_set_id } }).execute());
  const approval = await recordHumanGrade(db, tenant, { ...identity, attempt_label: "approval",
    details: humanGradeDetails("workflow_approval") });
  expect(approval.ok).toBe(true);
  const selection = { run_id: "run-1", revision_id: "rev-1", question_id: question.question_id,
    question_version: question.question_version };
  expect((await readCoverage(db, tenant, selection)).questions[0]?.graded).toBe(0);
  const rubric = await recordHumanGrade(db, tenant, { ...identity, attempt_label: "rubric",
    details: humanGradeDetails("human_rubric_answer") });
  expect(rubric.ok).toBe(true);
  const replay = await recordHumanGrade(db, tenant, { ...identity, attempt_label: "rubric",
    details: humanGradeDetails("human_rubric_answer") });
  expect(replay.ok && replay.value).toMatchObject({ was_replay: true,
    observation: { observation_id: rubric.ok ? rubric.value.observation?.observation_id : null } });
  const changed_origin = await recordHumanGrade(db, tenant, { ...identity, attempt_label: "rubric",
    details: humanGradeDetails("workflow_approval") });
  expect(changed_origin.ok).toBe(false);
  const grades = await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 });
  expect(grades?.items.map(({ observation }) => ({ question_id: observation.question_id,
    question_version: observation.question_version, evaluator_definition_id: observation.evaluator_definition_id,
    reviewer_id: observation.reviewer_id, origin: observation.origin })))
    .toEqual((["workflow_approval", "human_rubric_answer"] as const).map((origin) => ({ question_id: question.question_id,
      question_version: question.question_version, evaluator_definition_id: "human", reviewer_id: "reviewer", origin })));
  expect((await readCoverage(db, tenant, selection)).questions[0]?.graded).toBe(1);
}));
