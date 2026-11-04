import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { registerQuestion, listGrades, runGrade, registerGradingContext } from "../src/storage/grading-store";
import { storeHumanGradeInTransaction } from "../src/storage/backfill-store";
import { withTenant } from "../src/storage/database";
import { captureProjectedFixture, scratchGrading, tenant, pilotExpectations, humanGradeDetails, evidence, evaluator, question } from "./grading-fixture";
const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("criterion subjects and all retired question pins refuse new automated and human grading; historical observations stay labelled", () => scratchGrading(async (db) => {
  const captured = await captureProjectedFixture(db, { revision_id: "criterion-admission", artifact_kind: "brief", body: {
    cohort_id: "cohort", decisions_made: [], approaches_rejected: [], acceptance_criteria: [{ id: "c", text: "An obligation" }],
  } });
  const subject = captured.find((row) => row.item_kind === "criterion")!;
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }], grade: [{ ...tenant, token: "grade", reviewer_id: "reviewer" }] } });
  for (const id of ["plan.criterion_traceability", "brief.source_fidelity", "assessment.coverage"] as const) {
    const pinned = oakridgeQuestions(pilotExpectations)[id].definition;
    expect((await registerQuestion(db, tenant, pinned)).ok).toBe(true);
    const identity = { subject_occurrence_id: subject.occurrence_id, evidence_set_id: evidence.evidence_set_id, question_id: id, question_version: "v1",
      evaluator_definition_id: "human", config_digest: "config-1", attempt_label: "refused" };
    for (const path of ["/v1/grades", "/v1/evaluation-jobs"]) {
      const response = await app.request(path, { method: "POST", headers: { authorization: "Bearer grade" }, body: JSON.stringify({ identity,
        runner: "stub_model", details: humanGradeDetails("human_rubric_answer") }) });
      expect(response.status).toBe(422);
      expect((await response.json()).error.message).toContain("criterion");
    }
  }
  const wrapped = await app.request("/v1/evaluation-jobs", { method: "POST", headers: { authorization: "Bearer grade" }, body: JSON.stringify({
    identity: { subject_occurrence_id: "invented-criterion-wrapper", question_id: "assessment.coverage", question_version: "v1",
      evaluator_definition_id: "model", config_digest: "c", attempt_label: "refused" }, runner: "stub_model" }) });
  expect((await wrapped.json()).error.message).toContain("subject occurrence does not exist");
  await withTenant(db, tenant, (trx) => storeHumanGradeInTransaction(trx, tenant, { format: "observation.source-event/v1",
    definition_id: "definition-1", artifact_schema_version: "1", kind: "human_grade", event_kind: "operator_decided",
    run_id: "run-1", event_id: "historical", decision_id: "historical-decision", evaluator: { kind: "human" },
    unit: "implementation/cohort", review: "brief", decision: "approve", target: "criterion-admission", feedback: {}, effect: "approve", decided_at: "2026-10-29T00:00:00Z" }));
  const grades = await listGrades(db, tenant, subject.occurrence_id, { limit: 50, offset: 0 });
  expect(grades?.items[0]).toMatchObject({ legacy_readback: true, observation: { subject_occurrence_id: subject.occurrence_id },
    provenance: { definition_id: "definition-1", artifact_schema_version: "1" } });
}));
integration("definition changes do not gate new measurements and captured definition remains grade provenance", () => scratchGrading(async (db, occurrence_id) => {
  const pinned = { ...question, pinned_expectation: { ...question.pinned_expectation, definition_id: "different-workflow" } };
  expect((await registerGradingContext(db, tenant, { question: pinned, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const result = await runGrade(db, tenant, { identity: { subject_occurrence_id: occurrence_id, question_id: pinned.question_id,
    question_version: pinned.question_version, evidence_set_id: evidence.evidence_set_id, evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "new-definition" },
    runner: { kind: "code", async run() { return { ok: true, value: { answer: { state: "answered", kind: "boolean", value: true } } }; } } });
  expect(result.ok).toBe(true);
  expect((await listGrades(db, tenant, occurrence_id, { limit: 50, offset: 0 }))?.items[0]?.provenance?.definition_id).toBe("definition-1");
}));
