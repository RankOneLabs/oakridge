import { canonicalDigest } from "canonical-json";
import type { ItemOccurrenceId } from "../src/domain/identity";
import { expect, test } from "bun:test";
import { repositorySnapshotEligibility } from "../src/grading/eligibility";
import type { EvidenceSet } from "../src/grading/evidence";
import type { EvidenceSetId } from "../src/domain/identity";
import { listGrades, readExecution, recordHumanGrade, registerQuestion, registerGradingContext, runGrade } from "../src/storage/grading-store";
import { tenant, question, evidence, evaluator, scratchGrading } from "./grading-fixture";
import { createApp } from "../src/http/app";
import { checkEvidenceIntegrity } from "../src/grading/evidence-integrity";
import { captureDelivery } from "../src/storage/capture-store";
import { jsonText, withTenant } from "../src/storage/database";
import { projectRevision, listRunItems, readLineage } from "../src/storage/projection-store";
import { loadRunCapture } from "../src/storage/run-capture-store";
import { readEligibility } from "../src/storage/eligibility-store";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";
import { occurrenceId } from "../src/projection/occurrence-id";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { pilotExpectations, captureProjectedFixture } from "./grading-fixture";
import type { JsonValue } from "../src/domain/primitives";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL || process.env.CI === "true" ? test : test.skip;

test("evidence integrity accepts a reference carrying a digest without content", () => {
  expect(checkEvidenceIntegrity({ ...evidence, references: [{ ref: "captured", kind: "internal",
    content: null, digest: `canonical-json/v1:${"a".repeat(64)}` }] })).toEqual({ ok: true, value: undefined });
});

test("evidence integrity accepts content that canonicalizes without a supplied digest", () => {
  expect(checkEvidenceIntegrity({ ...evidence, references: [{ ref: "captured", kind: "raw_build_output",
    content: { output: "build passed" }, digest: null }] })).toEqual({ ok: true, value: undefined });
});

test("evidence integrity refuses a reference with neither content nor digest", () => {
  expect(checkEvidenceIntegrity({ ...evidence, references: [{ ref: "missing", content: null, digest: null }] }))
    .toEqual({ ok: false, error: { operation: "evidence_integrity", entity_id: evidence.evidence_set_id,
      detail: "evidence content has no canonical digest" } });
});

test("evidence integrity failure does not include content or a canonicalization path", () => {
  const result = checkEvidenceIntegrity({ ...evidence, references: [{ ref: "do-not-log", kind: "raw_test_output",
    content: { "private-test-output": Number.NaN }, digest: null }] });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/do-not-log|private-test-output|NaN/);
});

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
    origin: "human_rubric_answer" as const, collection_mode: "in_context" as const, model_answers_visible: false, workflow_decisions_visible: false,
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

integration("production reader pins canonical references to captured source revisions", async () => scratchGrading(async (db) => {
  const { captureProjectedFixture, pilotExpectations } = await import("./grading-fixture");
  const { oakridgeQuestions } = await import("../src/grading/catalogue/oakridge-questions");
  const { deriveCapturedEvidence } = await import("../src/storage/captured-evidence-store");
  const body = { cohorts: [{ id: "cohort", decisions: [{ id: "decision", text: "source" }],
    acceptance_criteria: [{ id: "criterion", text: "Works", task_ids: [], decision_ids: ["decision"] }] }],
    acceptance_criteria: [], risks: [] };
  const items = await captureProjectedFixture(db, { revision_id: "plan-first", artifact_kind: "plan", body });
  const subject = items.find((item) => item.item_kind === "criterion")!;
  const selection = { subject_occurrence_id: subject.occurrence_id as ItemOccurrenceId,
    question: oakridgeQuestions(pilotExpectations)["plan.criterion_traceability"].definition };
  const first = await deriveCapturedEvidence(db, tenant, "run-1", selection);
  if (!first.ok) throw new Error(first.error.detail);
  expect(first.value.subject).toMatchObject({ occurrence_id: subject.occurrence_id, revision_id: "plan-first" });
  expect(first.value.revision_id).toBe("plan-first");
  expect(first.value.decision.tag).toBe("eligible");
  expect(first.value.evidence?.references).toHaveLength(2);
  for (const reference of first.value.evidence!.references) {
    const source = items.find((item) => reference.deep_link === `oakridge://revision/plan-first#${item.json_pointer}`)!;
    const digest = canonicalDigest(source.selected_value);
    expect(reference.digest).toBe(digest.ok ? digest.value : null);
  }
  await captureProjectedFixture(db, { revision_id: "plan-new", artifact_kind: "plan", body: {
    ...body, cohorts: [{ ...body.cohorts[0]!, decisions: [{ id: "decision", text: "changed source" }] }],
  }, recorded_at: "2026-11-01T01:00:00Z", predecessor_id: "plan-first" });
  expect(await deriveCapturedEvidence(db, tenant, "run-1", selection)).toEqual(first);
}));

integration("legacy extractor identities retain eligibility and lineage but refuse new grading alongside cohort-scoped captures", async () => scratchGrading(async (db) => {
  for (const [artifact_kind, extractor_id, body] of [
    ["plan", "plan.criteria", { cohorts: [{ id: "cohort", decisions: [{ id: "decision", text: "source" }],
      acceptance_criteria: [{ id: "criterion", text: "Original criterion", task_ids: [], decision_ids: ["decision"] }] }],
      acceptance_criteria: [], risks: [] }],
    ["brief", "brief.criteria", { cohort_id: "cohort", decisions_made: [], approaches_rejected: [],
      acceptance_criteria: [{ id: "criterion", text: "Brief criterion", task_ids: [], decision_ids: [] }] }],
    ["assessment", "assessment.findings", { findings: [{ criterion_id: "criterion", evidence: [], description: "Covered" }] }],
  ] as const) {
    const revision_id = `legacy-${artifact_kind}`;
    const value = body as unknown as JsonValue;
    const digest = canonicalDigest(value);
    if (!digest.ok) throw new Error(digest.error.detail);
    const captured = await captureDelivery(db, { local_revision_id: revision_id, request_key: revision_id,
      envelope: { format: "observation.artifact-revision/v2", source: { ...tenant, definition_id: "definition-1", artifact_schema_version: "1",
        revision_id: `${tenant.producer}:${tenant.namespace}:${revision_id}`, run_id: "run-1", unit_id: "implementation/cohort",
        artifact_kind, predecessor_id: null, subject_id: null }, body: value, body_digest: digest.value, recorded_at: "2026-11-01T00:00:00Z" } });
    expect(captured.status).toBe(201);
    const definitions = oakridgeDevelopmentCatalogue(artifact_kind, "1", { unit_id: "implementation/cohort",
      extractor_versions: [{ extractor_id, extractor_version: "1" }] });
    // Seed the historical projection shape; production replay must honor these persisted pins.
    const selected = selectRevision(value, revision_id, definitions).items.filter((entry) => entry.definition.extractor_id === extractor_id);
    await withTenant(db, tenant, async (trx) => {
      for (const { definition, item } of selected) {
        const identity = occurrenceId({ ...tenant, revision_id, extractor_id, extractor_version: "1",
          item_selector: item.item_selector, item_id_or_path: item.item_id_or_path });
        if (!identity.ok) throw new Error(identity.error.detail);
        const { select: _select, ...stored_definition } = definition;
        await trx.insertInto("observation.extractor_definition").values({ ...tenant, ...stored_definition }).execute();
        await trx.insertInto("observation.item_occurrence").values({ ...tenant, revision_id, run_id: "run-1", artifact_kind,
          occurrence_id: identity.value, schema_version: "1", extractor_id, extractor_version: "1", item_kind: item.item_kind,
          item_selector: item.item_selector, item_id_or_path: item.item_id_or_path, item_scope: item.item_scope,
          producer_local_id: item.producer_local_id, selected_value: jsonText(item.selected_value), logical_item_id: null,
          json_pointer: null }).execute();
      }
    });
    await projectRevision(db, tenant, revision_id);
  }
  const before = await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 });
  const capture = await loadRunCapture(db, tenant, "run-1");
  if (!capture.ok) throw new Error(capture.error.detail);
  const legacy_items = capture.value.flatMap((revision) => revision.items);
  expect(legacy_items.map((item) => String(item.occurrence_id)).sort()).toEqual(before.items
    .filter((item) => item.revision_id.startsWith("legacy-")).map((item) => item.occurrence_id).sort());
  const questions = oakridgeQuestions(pilotExpectations);
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }], grade: [{ ...tenant, token: "grade" }] } });
  for (const [artifact_kind, question_id] of [["plan", "plan.criterion_traceability"], ["brief", "brief.source_fidelity"]] as const) {
    const subject = before.items.find((item) => item.revision_id === `legacy-${artifact_kind}` && item.item_kind === "criterion")!;
    expect(subject).toMatchObject({ item_id_or_path: "criterion:criterion", item_scope: "criterion", extractor_version: "1" });
    const question = questions[question_id].definition;
    expect((await registerQuestion(db, tenant, question)).ok).toBe(true);
    const queued = await app.request("/v1/evaluation-jobs", { method: "POST",
      headers: { authorization: "Bearer grade", "content-type": "application/json" }, body: JSON.stringify({
        identity: { subject_occurrence_id: subject.occurrence_id, question_id, question_version: question.question_version,
          evaluator_definition_id: "model", config_digest: "config-1", attempt_label: "legacy" },
        context: { question, evaluator: evaluator("model") }, runner: "stub_model" }) });
    expect({ status: queued.status, body: await queued.clone().text() }).toMatchObject({ status: 422 });
    const eligibility = await readEligibility(db, tenant, { run_id: "run-1", revision_id: subject.revision_id,
      question_id, question_version: question.question_version, limit: 20, offset: 0 });
    expect(eligibility.items).toMatchObject([{ subject_occurrence_id: subject.occurrence_id, tag: "eligible" }]);
    const lineage = await readLineage(db, tenant, subject.occurrence_id, { limit: 200, offset: 0 });
    expect(lineage?.edges.some((edge) => edge.type === "derived_from")).toBe(true);
    const assigned = await app.request("/v1/blind-assignments", { method: "POST",
      headers: { authorization: "Bearer grade", "content-type": "application/json" }, body: JSON.stringify({
        subject_occurrence_id: subject.occurrence_id, question_id, question_version: question.question_version }) });
    expect(assigned.status).toBe(409);
  }
  const current = await captureProjectedFixture(db, { revision_id: "current-brief", artifact_kind: "brief",
    recorded_at: "2026-11-01T01:00:00Z", body: { cohort_id: "cohort", decisions_made: [], approaches_rejected: [],
      acceptance_criteria: [{ id: "criterion", text: "Current criterion" }] } });
  expect(current.find((item) => item.item_kind === "criterion")).toMatchObject({
    extractor_version: "2", item_scope: "cohort/cohort/criterion", item_id_or_path: "cohort/cohort/criterion:criterion" });
  for (const kind of ["plan", "brief", "assessment"]) await projectRevision(db, tenant, `legacy-${kind}`);
  const after = await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 });
  expect(after.items.filter((item) => item.revision_id.startsWith("legacy-"))).toEqual(before.items
    .filter((item) => item.revision_id.startsWith("legacy-")));
}));
