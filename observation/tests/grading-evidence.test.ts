import { expect, test } from "bun:test";
import { repositorySnapshotEligibility } from "../src/grading/eligibility";
import type { EvidenceSet } from "../src/grading/evidence";
import type { EvidenceSetId } from "../src/domain/identity";
import { listGrades, readExecution, recordHumanGrade, registerGradingContext, runGrade } from "../src/storage/grading-store";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";
import { createApp } from "../src/http/app";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL || process.env.CI === "true" ? test : test.skip;

test("repository snapshot eligibility checks presence, classification, commit and excerpt provenance", () => {
  const valid: EvidenceSet = { evidence_set_id: "repository-evidence" as EvidenceSetId,
    references: [{ ref: "relevant_excerpt:src/main.ts", kind: "repository_content", content: null,
      digest: `canonical-json/v1:${"a".repeat(64)}`, reviewed_commit: "abc123" }],
    is_incomplete: false, incompleteness_reason: null };
  const decide = (value: EvidenceSet, minimum = 1) => repositorySnapshotEligibility(value, minimum, "abc123").tag;
  expect(decide({ ...valid, references: [] })).toBe("missing_evidence");
  expect(decide(valid, 2)).toBe("missing_evidence");
  expect(decide({ ...valid, references: [{ ...valid.references[0]!, kind: "public" }] })).toBe("missing_evidence");
  expect(decide({ ...valid, references: [{ ...valid.references[0]!, reviewed_commit: undefined }] })).toBe("missing_evidence");
  expect(decide({ ...valid, references: [{ ...valid.references[0]!, digest: null }] })).toBe("missing_evidence");
  expect(decide({ ...valid, references: [{ ...valid.references[0]!, is_truncated: true }] })).toBe("missing_evidence");
  expect(decide({ ...valid, references: [{ ...valid.references[0]!, is_unreadable: true }] })).toBe("missing_evidence");
  expect(decide(valid)).toBe("eligible");
});

integration("incomplete repository evidence records a failed execution and no grade", async () => scratchGrading(async (db, occurrence_id) => {
  const context = { question: { ...question, requires_repository_snapshot: true },
    evidence: { ...evidence, is_incomplete: true, incompleteness_reason: "repository snapshot missing" }, evaluator: evaluator("code") };
  expect((await registerGradingContext(db, tenant, context)).ok).toBe(true);
  const result = await runGrade(db, tenant, { identity: { subject_occurrence_id: occurrence_id,
    evidence_set_id: evidence.evidence_set_id, question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "incomplete" },
    runner: { kind: "code", run: async () => { throw new Error("must not execute"); } } });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.detail);
  expect(result.value.observation).toBeNull();
  expect(result.value.execution.status).toBe("failed");
  expect(result.value.execution.error).toBe("repository snapshot missing");
  expect((await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 }))?.total).toBe(0);
  expect((await readExecution(db, tenant, result.value.execution.execution_id))?.status).toBe("failed");
}));

integration("runner failure remains queryable only as an execution", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const result = await runGrade(db, tenant, { identity: { subject_occurrence_id: occurrence_id,
    evidence_set_id: evidence.evidence_set_id, question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "code", config_digest: "config-1", attempt_label: "fails" },
    runner: { kind: "code", run: async () => ({ ok: false, error: { operation: "fixture", entity_id: "code", detail: "grader unavailable" } }) } });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.detail);
  expect(result.value.execution.status).toBe("failed");
  expect(result.value.observation).toBeNull();
  expect((await readExecution(db, tenant, result.value.execution.execution_id))?.error).toBe("grader unavailable");
  expect((await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 }))?.items).toEqual([]);
}));

integration("abstain and unclear remain distinct from a negative answer and no evaluation", async () => scratchGrading(async (db, occurrence_id) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("human") })).ok).toBe(true);
  const identity = { subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id,
    question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "human", config_digest: "config-1" };
  const details = { probabilities: null, confidence: null, normalized_score: null, decision_policy_id: null,
    decision_policy_version: null, reviewer_id: "reviewer", reviewer_details: null, comments: null,
    rationale: null, quality_flags: [], supersedes_observation_id: null };
  for (const [attempt_label, answer] of [
    ["abstain", { state: "abstain", kind: "boolean", reason: "insufficient context" }],
    ["unclear", { state: "unclear", kind: "boolean", reason: "conflicting evidence" }],
    ["negative", { state: "answered", kind: "boolean", value: false }],
  ] as const) {
    expect((await recordHumanGrade(db, tenant, { ...identity, attempt_label, details: { ...details, answer } })).ok).toBe(true);
  }
  const grades = await listGrades(db, tenant, occurrence_id, { limit: 10, offset: 0 });
  expect(grades?.items.map((item) => item.answer.state).sort()).toEqual(["abstain", "answered", "unclear"]);
  expect(grades?.total).toBe(3);
  const app = createApp({ db, credentials: { ingest: [], grade: [], read: [{ ...tenant, token: "read" }] } });
  const response = await app.request(`/v1/items/${encodeURIComponent(occurrence_id)}/grades`,
    { headers: { authorization: "Bearer read" } });
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.items.map((item: { answer: { state: string } }) => item.answer.state).sort()).toEqual(["abstain", "answered", "unclear"]);
}));
