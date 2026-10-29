import { expect, test } from "bun:test";
import type { JsonValue } from "../src/domain/primitives";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";
import { checkAssessmentCoverage, coverageInput } from "../src/runners/coverage-checker";
import { createApp } from "../src/http/app";
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import { tenant, evidence, evaluator, scratchGrading } from "./grading-fixture";

test("a brief criterion with no covering assessment finding is a coverage miss", async () => {
  const brief = await Bun.file(new URL("../fixtures/oakridge/brief-revision.json", import.meta.url)).json() as JsonValue;
  const selected = selectRevision(brief, "brief-revision", oakridgeDevelopmentCatalogue("brief", "development-v1"));
  const criterion = selected.items.find(({ item }) => item.item_kind === "criterion")?.item;
  if (!criterion) throw new Error("fixture has no brief criterion");
  const input = coverageInput(criterion, []);
  expect(input.ok).toBe(true);
  if (!input.ok) return;
  const result = checkAssessmentCoverage(input.value);
  expect(result.ok && result.value.answer).toEqual({ state: "answered", kind: "boolean", value: false });
});

test("an assessment finding without criterion_id adds no miss or inferred link", async () => {
  const brief = await Bun.file(new URL("../fixtures/oakridge/brief-revision.json", import.meta.url)).json() as JsonValue;
  const selected = selectRevision(brief, "brief-revision", oakridgeDevelopmentCatalogue("brief", "development-v1"));
  const criterion = selected.items.find(({ item }) => item.item_kind === "criterion")?.item;
  if (!criterion) throw new Error("fixture has no brief criterion");
  const assessment: JsonValue = { findings: [
    { description: "integration finding", evidence: [] },
    { criterion_id: criterion.producer_local_id, description: "criterion finding", evidence: [] },
  ] };
  const findings = selectRevision(assessment, "assessment-revision", oakridgeDevelopmentCatalogue("assessment", "development-v1"))
    .items.map(({ item }) => item);
  expect(findings[0]?.links).toEqual([]);
  const input = coverageInput(criterion, findings);
  expect(input.ok).toBe(true);
  if (!input.ok) return;
  const result = checkAssessmentCoverage(input.value);
  expect(result.ok && result.value.answer).toEqual({ state: "answered", kind: "boolean", value: true });
});

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL || process.env.CI === "true" ? test : test.skip;
integration("the service runs the deterministic coverage checker over local link evidence", async () => scratchGrading(async (db, occurrence_id) => {
  const question = { ...LANGFUSE_PILOT_QUESTIONS["assessment.coverage"].definition,
    target_item_kinds: ["cohort_criterion"] };
  const links = { brief_criterion: { item_kind: "criterion", item_scope: "cohort/alpha/criterion",
    producer_local_id: "crit-a" }, assessment_findings: [{ item_kind: "assessment_finding", links: [] }] };
  const context = { question, evidence: { ...evidence, references: [{ ref: "local-links", kind: "public" as const,
    content: links, digest: null }] }, evaluator: evaluator("code") };
  const app = createApp({ db, credentials: { ingest: [], read: [], grade: [{ ...tenant, token: "grade" }] } });
  const response = await app.request("/v1/evaluations", { method: "POST",
    headers: { authorization: "Bearer grade", "content-type": "application/json" },
    body: JSON.stringify({ identity: { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "coverage" },
    context, runner: "coverage" }) });
  expect(response.status).toBe(201);
  expect((await response.json()).observation.answer_payload).toEqual({ state: "answered", kind: "boolean", value: false });
}));
