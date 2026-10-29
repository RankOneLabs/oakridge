import { expect, test } from "bun:test";
import type { ArtifactRevisionId, CanonicalDigest, EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId, RunId } from "../src/domain/identity";
import type { EvidenceSet } from "../src/grading/evidence";
import type { EvaluationExecution } from "../src/grading/execution";
import type { QuestionDefinition } from "../src/grading/question";
import { mappingKey } from "../src/langfuse/mapping";
import { encodeProjection } from "../src/langfuse/projection";
import { TestEvaluationBackend } from "../src/langfuse/test-double";
import { LocalEvaluationBackend, type EvaluationBackend, type LogicalItemId, type ObservationUnitId,
  type ProjectionInput } from "../src/ports/evaluation-backend";

const question: QuestionDefinition = { question_id: "criterion-check" as QuestionId, question_version: "1",
  target_item_kinds: ["criterion"], input_recipe: { expected: "clear" }, response_kind: "boolean",
  allowed_values: null, missing_evidence_policy: "abstain", abstain_semantics: "missing",
  unclear_semantics: "ambiguous", interpretation_caveats: "pilot", requires_repository_snapshot: false };
const evidence: EvidenceSet = { evidence_set_id: "evidence-1" as EvidenceSetId,
  references: [
    { ref: "artifact:brief", kind: "public", content: "clear", digest: null },
    { ref: "artifact:test-output", kind: "raw_test_output", content: "private log", digest: null },
  ], is_incomplete: false, incompleteness_reason: null };
const execution: EvaluationExecution = { execution_id: "execution-1" as ExecutionId,
  subject_occurrence_id: "occurrence-1" as ItemOccurrenceId, evidence_set_id: evidence.evidence_set_id,
  question_id: question.question_id, question_version: question.question_version,
  evaluator_definition_id: "evaluator-1", config_digest: "config-1", attempt_label: "first",
  idempotency_digest: "digest-1", attempts: 1, retries: 0, started_at: new Date(0), ended_at: new Date(1),
  status: "completed", error: null, model_usage: null, cost: null, external_execution_id: null,
  provider_link: null, reproducibility_metadata: null };
const input: ProjectionInput = { execution, evidence, question, question_text: "Is this criterion clear?",
  source: { producer: "oakridge", namespace: "development", run_id: "run-1" as RunId,
    unit_id: "unit-1" as ObservationUnitId, artifact_kind: "brief",
    revision_id: "revision-1" as ArtifactRevisionId, revision_digest: "canonical-json/v1:abc" as CanonicalDigest,
    logical_item_id: "criterion-1" as LogicalItemId, extractor_version: "1" },
  policy: { body_sensitivity: { analysis: "restricted", plan: "internal", brief: "internal", assessment: "restricted" },
    allow_raw_build_output: false, allow_raw_test_output: false, allow_repository_content: false },
  projection_version: "1" };

test("projection encodes pinned metadata, question and policy-scoped evidence", () => {
  const result = encodeProjection(input);
  if (!result.ok) throw new Error(result.error.detail);
  expect(result.value.trace.metadata).toEqual({ producer: "oakridge", namespace: "development",
    run_id: input.source.run_id, unit_id: input.source.unit_id, artifact_kind: "brief",
    revision_id: input.source.revision_id, revision_digest: input.source.revision_digest,
    logical_item_id: input.source.logical_item_id!, occurrence_id: execution.subject_occurrence_id,
    extractor_version: "1", question_id: question.question_id, question_version: "1", projection_version: "1",
    privacy_classification: "internal" });
  expect(result.value.observation.input.question_text).toBe("Is this criterion clear?");
  expect(result.value.observation.input.evidence_set.evidence_refs).toEqual([
    { ref: "artifact:brief", kind: "public", content: "clear", digest: null, is_redacted: false },
    { ref: "artifact:test-output", kind: "raw_test_output", content: null, digest: null, is_redacted: true },
  ]);
  expect(result.value.score_name).toBe("criterion-check@1");
});

test("projection omits absent logical item ID", () => {
  const result = encodeProjection({ ...input, source: { ...input.source, logical_item_id: null } });
  if (!result.ok) throw new Error(result.error.detail);
  expect(Object.hasOwn(result.value.trace.metadata, "logical_item_id")).toBe(false);
});

test("projection rejects a question that differs from the execution", () => {
  const result = encodeProjection({ ...input, question: { ...question, question_version: "2" } });
  expect(result).toMatchObject({ ok: false, error: { operation: "encode_projection", entity_id: "execution-1" } });
});

test("network-free test double implements project, fetch and reconcile through the port", async () => {
  const backend: EvaluationBackend = new TestEvaluationBackend();
  const projected = await backend.project(input);
  if (!projected.ok) throw new Error(projected.error.detail);
  if (projected.value.status !== "complete") throw new Error("test double projects complete targets");
  const external_ids = projected.value.external_ids;
  const digest = mappingKey({ occurrence_id: execution.subject_occurrence_id, evidence,
    question_id: question.question_id, question_version: question.question_version, projection_version: "1" });
  if (!digest.ok) throw new Error(digest.error.detail);
  const selector = { mapping_key: digest.value.mapping_key, external_ids };
  expect((await backend.project(input))).toEqual(projected);
  expect(await backend.fetch(selector)).toEqual({ ok: true, value: { scores: [], annotation_outcomes: [] } });
  const reconciled = await backend.reconcile({ ...selector, occurrence_id: execution.subject_occurrence_id,
    question_id: question.question_id, question_version: question.question_version });
  expect(reconciled).toMatchObject({ ok: true, value: { external_ids,
    sync_state: { status: "pending", mapping_key: selector.mapping_key } } });
});

test("offline backend reports disabled projection as a domain error", async () => {
  const backend: EvaluationBackend = new LocalEvaluationBackend();
  expect(await backend.project(input)).toMatchObject({ ok: false,
    error: { operation: "project", entity_id: "execution-1", detail: "Langfuse adapter is disabled" } });
});
