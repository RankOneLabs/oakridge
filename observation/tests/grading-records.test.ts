import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { registerGradingContext } from "../src/storage/grading-store";
import { evidence, evaluator, question, scratchGrading, tenant } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
if (!process.env.OAKRIDGE_TEST_DATABASE_URL) console.warn("SKIP: grading record HTTP readback; missing OAKRIDGE_TEST_DATABASE_URL");
integration("immutable question and evidence readback requires read authority and hides other tenants", () => scratchGrading(async (db) => {
  const registered = await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("code") });
  expect(registered.ok).toBe(true);
  const app = createApp({ db, credentials: {
    ingest: [{ ...tenant, token: "ingest" }],
    read: [{ ...tenant, token: "read" }, { ...tenant, namespace: "other", token: "other" }],
    grade: [{ ...tenant, token: "grade", reviewer_id: "reviewer" }],
  } });
  const paths = ["/v1/questions/relevance/versions/1", "/v1/evidence-sets/evidence-1"];
  for (const path of paths) {
    for (const token of [null, "invalid", "ingest", "grade"]) {
      const response = await app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      expect(response.status).toBe(403);
    }
    expect((await app.request(path, { headers: { authorization: "Bearer other" } })).status).toBe(404);
    expect((await app.request(`${path}-missing`, { headers: { authorization: "Bearer read" } })).status).toBe(404);
  }
  const stored_question = await app.request(paths[0]!, { headers: { authorization: "Bearer read" } });
  expect(stored_question.status).toBe(200);
  expect(await stored_question.json()).toMatchObject({ question_id: question.question_id,
    question_version: question.question_version, input_recipe: question.input_recipe,
    expected_definition_id: question.pinned_expectation.definition_id,
    expected_artifact_schema_version: question.pinned_expectation.artifact_schema_version });
  const stored_evidence = await app.request(paths[1]!, { headers: { authorization: "Bearer read" } });
  expect(stored_evidence.status).toBe(200);
  expect(await stored_evidence.json()).toMatchObject({ evidence_set_id: evidence.evidence_set_id,
    evidence_refs: evidence.references, is_incomplete: evidence.is_incomplete,
    incompleteness_reason: evidence.incompleteness_reason });
}));
