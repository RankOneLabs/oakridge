import { expect, test } from "bun:test";
import type { JsonValue } from "../src/domain/primitives";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";
import { checkAssessmentCoverage, coverageInput } from "../src/runners/coverage-checker";
import { createApp } from "../src/http/app";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { pilotExpectations } from "./grading-fixture";
const OAKRIDGE_QUESTIONS = oakridgeQuestions(pilotExpectations);
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
  const findings = selectRevision(assessment, "assessment-revision", oakridgeDevelopmentCatalogue("assessment", "development-v1", { unit_id: "implementation/alpha" }))
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
  const question = { ...OAKRIDGE_QUESTIONS["assessment.coverage"].definition,
    target_item_kinds: ["cohort_criterion"] };
  const links = { brief_criterion: { item_kind: "criterion", item_scope: "criterion",
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
  expect(response.status).toBe(422);
  expect((await response.json()).error.message).toContain("criterion-targeting");
}));

integration("the retired coverage question is refused before queuing work", async () => scratchGrading(async (db, occurrence_id) => {
  const app = createApp({ db, credentials: { ingest: [], read: [], grade: [{ ...tenant, token: "grade" }] } });
  const question = OAKRIDGE_QUESTIONS["assessment.coverage"].definition;
  const response = await app.request("/v1/evaluation-jobs", { method: "POST", headers: { authorization: "Bearer grade" },
    body: JSON.stringify({ identity: { subject_occurrence_id: occurrence_id, question_id: question.question_id,
      question_version: question.question_version, evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "retired" },
      context: { question, evaluator: evaluator("code") }, runner: "coverage" }) });
  expect(response.status).toBe(422);
  expect((await response.json()).error.message).toContain("criterion-targeting");
}));
