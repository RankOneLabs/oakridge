import { expect, test } from "bun:test";
import { repositorySnapshotEligibility } from "../src/grading/eligibility";
import type { EvidenceSet } from "../src/grading/evidence";
import type { EvidenceSetId } from "../src/domain/identity";
import { listGrades, readExecution, recordHumanGrade, registerGradingContext, runGrade } from "../src/storage/grading-store";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";
import { createApp } from "../src/http/app";
import { evidenceSetDigest } from "../src/grading/evidence";
import { sql } from "kysely";
import { withTenant } from "../src/storage/database";

const evidenceReadIntegration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
evidenceReadIntegration("evidence read preserves digest and hides restricted content in serialized JSON", async () =>
  scratchGrading(async (db) => {
    const references = ["public", "repository_content", "raw_build_output", "raw_test_output", "internal", undefined]
      .map((kind, index) => ({ ref: `source:${index}`, ...(kind ? { kind } : {}),
        content: `secret-${index}`, digest: `digest-${index}`, deep_link: `link-${index}`,
        reviewed_commit: "abc", is_truncated: true, is_unreadable: false, incompleteness_reason: "partial" }));
    await withTenant(db, tenant, (trx) => sql`INSERT INTO observation.evidence_set
      (producer, namespace, evidence_set_id, evidence_refs, is_incomplete, incompleteness_reason)
      VALUES (${tenant.producer}, ${tenant.namespace}, 'mixed', ${JSON.stringify(references)}::jsonb, false, null)`.execute(trx));
    const app = createApp({ db, credentials: { ingest: [], grade: [], read: [{ ...tenant, token: "read" }] } });
    const route = "/v1/evidence-sets/mixed";
    const unauthorized = await app.request(route);
    expect([unauthorized.status, (await unauthorized.json()).error.code]).toEqual([403, "forbidden"]);
    const missing = await app.request("/v1/evidence-sets/missing", { headers: { authorization: "Bearer read" } });
    expect([missing.status, (await missing.json()).error.code]).toEqual([404, "not_found"]);
    const response = await app.request(route, { headers: { authorization: "Bearer read" } });
    const body = JSON.parse(await response.text());
    const digest = evidenceSetDigest({ evidence_set_id: "mixed" as EvidenceSetId,
      references: references as EvidenceSet["references"], is_incomplete: false, incompleteness_reason: null });
    expect(body.digest).toBe(digest.ok ? digest.value : null);
    expect(body.evidence_refs.map((ref: { content?: string }) => ref.content ?? null))
      .toEqual(["secret-0", "secret-1", null, null, null, null]);
    expect(body.evidence_refs[5]).toMatchObject({ ref: "source:5", digest: "digest-5", deep_link: "link-5",
      reviewed_commit: "abc", is_truncated: true, is_unreadable: false, incompleteness_reason: "partial" });
  }));

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

integration("runGrade checks each repository snapshot condition using the per-run reviewed commit", async () => scratchGrading(async (db, occurrence_id) => {
  const snapshotQuestion = { ...question, requires_repository_snapshot: true,
    input_recipe: { ...question.input_recipe, minimum_repository_content: 2 } };
  const source = { ref: "relevant_excerpt:src/main.ts", kind: "repository_content" as const, content: null,
    digest: `canonical-json/v1:${"a".repeat(64)}`, reviewed_commit: "abc123" };
  const sources = [source, { ...source, ref: "relevant_excerpt:src/lib.ts" }];
  const cases: readonly { name: string; references: EvidenceSet["references"]; reviewed_commit?: string;
    expected: "completed" | "failed" }[] = [
    { name: "too-few", references: [sources[0]!], reviewed_commit: "abc123", expected: "failed" },
    { name: "classification", references: [sources[0]!, { ...sources[1]!, kind: "public" }], reviewed_commit: "abc123", expected: "failed" },
    { name: "source-commit", references: [sources[0]!, { ...sources[1]!, reviewed_commit: undefined }], reviewed_commit: "abc123", expected: "failed" },
    { name: "no-run-commit", references: sources, expected: "failed" },
    { name: "requested-commit", references: sources, reviewed_commit: "different", expected: "failed" },
    { name: "digest", references: [sources[0]!, { ...sources[1]!, digest: null }], reviewed_commit: "abc123", expected: "failed" },
    { name: "truncation", references: [sources[0]!, { ...sources[1]!, is_truncated: true }], reviewed_commit: "abc123", expected: "failed" },
    { name: "complete", references: sources, reviewed_commit: "abc123", expected: "completed" },
  ];
  let runner_calls = 0;
  for (const entry of cases) {
    const snapshotEvidence: EvidenceSet = { evidence_set_id: `repository-${entry.name}` as EvidenceSetId,
      references: entry.references, is_incomplete: false, incompleteness_reason: null };
    expect((await registerGradingContext(db, tenant, { question: snapshotQuestion, evidence: snapshotEvidence,
      evaluator: evaluator("code") })).ok).toBe(true);
    const result = await runGrade(db, tenant, { identity: { subject_occurrence_id: occurrence_id,
      evidence_set_id: snapshotEvidence.evidence_set_id, question_id: question.question_id,
      question_version: question.question_version, evaluator_definition_id: "code", config_digest: "config-1",
      attempt_label: entry.name }, reviewed_commit: entry.reviewed_commit,
      runner: { kind: "code", run: async () => { runner_calls++; return { ok: true as const,
        value: { answer: { state: "answered" as const, kind: "boolean" as const, value: true } } }; } } });
    expect(result.ok && result.value.execution.status).toBe(entry.expected);
  }
  expect(runner_calls).toBe(1);
  const changedCommit = await runGrade(db, tenant, { identity: { subject_occurrence_id: occurrence_id,
    evidence_set_id: "repository-complete" as EvidenceSetId, question_id: question.question_id,
    question_version: question.question_version, evaluator_definition_id: "code", config_digest: "config-1",
    attempt_label: "complete" }, reviewed_commit: "different",
    runner: { kind: "code", run: async () => { throw new Error("must not execute"); } } });
  expect(changedCommit.ok && changedCommit.value.execution.status === "failed" && !changedCommit.value.was_replay).toBe(true);
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
    collection_mode: "in_context" as const, model_answers_visible: false, workflow_decisions_visible: false,
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
