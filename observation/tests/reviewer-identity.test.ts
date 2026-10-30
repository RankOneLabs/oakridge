import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { boundReviewer, credentialsFromEnv } from "../src/http/ingest-auth";
import { question, evidence, evaluator, scratchGrading, tenant } from "./grading-fixture";

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
      collection_mode: "in_context", model_answers_visible: false, workflow_decisions_visible: false } };
  const headers = { authorization: "Bearer grade", "content-type": "application/json" };
  const forged = await app.request("/v1/grades", { method: "POST", headers,
    body: JSON.stringify({ ...request, details: { ...request.details, reviewer_id: "other-reviewer" } }) });
  expect(forged.status).toBe(403);
  const accepted = await app.request("/v1/grades", { method: "POST", headers, body: JSON.stringify(request) });
  expect(accepted.status).toBe(201);
  expect((await accepted.json()).observation.reviewer_id).toBe("bound-reviewer");
}));
