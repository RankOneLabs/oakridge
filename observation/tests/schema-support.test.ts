import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { schemaSupport } from "../src/grading/evidence-packages/recipe";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { registerQuestion } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { scratchGrading, tenant, pilotExpectations, captureProjectedFixture } from "./grading-fixture";
const question = oakridgeQuestions(pilotExpectations)["analysis.finding_relevance"].definition;
const subject = { item_kind: "finding", artifact_kind: "analysis", definition_id: "different-workflow", artifact_schema_version: "1" };
test("schema support depends on schema, selected kind and implemented recipe; definition is provenance", () => {
  expect(schemaSupport(question, subject)).toEqual({ state: "supported" });
  expect(schemaSupport(question, { ...subject, artifact_schema_version: "unknown" }).state).toBe("unsupported");
  expect(schemaSupport(question, { ...subject, item_kind: "criterion" })).toMatchObject({ state: "unsupported", reason: expect.stringContaining("obligation") });
  expect(schemaSupport({ ...question, input_recipe: {} }, subject).state).toBe("unsupported");
});
const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("supported findings stay visible with missing evidence, no criterion link, and unchanged legacy rows", () => scratchGrading(async (db) => {
  await captureProjectedFixture(db, { revision_id: "support-analysis", artifact_kind: "analysis", body: {
    findings: [{ id: "f", description: "finding", severity: "info" }], requirements: [], spec_updates: [],
  } });
  expect((await registerQuestion(db, tenant, question)).ok).toBe(true);
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }] } });
  const response = await app.request("/v1/grading-support/v1?run_id=run-1", { headers: { authorization: "Bearer read" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ query_version: "grading-support/v1", run_state: "applicable_question_pins",
    items: expect.arrayContaining([{ subject_occurrence_id: expect.any(String), question_id: question.question_id,
      question_version: "v1", provenance: { definition_id: "definition-1", artifact_schema_version: "1" },
      support: { state: "supported" }, readiness: { state: "unready", reason: expect.stringContaining("excerpt") },
      execution: { state: "not_started" } }]) });
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_eligibility").selectAll().execute())).toEqual([]);
  const other = { ...question, question_id: "unknown-schema" as typeof question.question_id, pinned_expectation: { definition_id: "irrelevant", artifact_schema_version: "absent" } };
  await withTenant(db, tenant, (trx) => trx.deleteFrom("observation.question_definition").where("question_id", "=", question.question_id).execute());
  expect((await registerQuestion(db, tenant, other)).ok).toBe(true);
  expect(await (await app.request("/v1/grading-support/v1?run_id=run-1", { headers: { authorization: "Bearer read" } })).json())
    .toMatchObject({ run_state: "no_applicable_question_pins", items: expect.arrayContaining([expect.objectContaining({ support: { state: "unsupported", reason: expect.stringContaining("schema") } })]) });
}));
