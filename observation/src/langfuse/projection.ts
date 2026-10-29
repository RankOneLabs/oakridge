import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { EvidenceReference } from "../grading/evidence";
import type { EvaluationExecution } from "../grading/execution";
import type { LangfuseError, PrivacyClassification, ProjectionInput, ProjectionPolicy,
  ProjectionSource } from "../ports/evaluation-backend";

export interface TraceMetadata {
  readonly producer: string;
  readonly namespace: string;
  readonly run_id: ProjectionSource["run_id"];
  readonly unit_id: ProjectionSource["unit_id"];
  readonly artifact_kind: string;
  readonly revision_id: ProjectionSource["revision_id"];
  readonly revision_digest: ProjectionSource["revision_digest"];
  readonly logical_item_id?: NonNullable<ProjectionSource["logical_item_id"]>;
  readonly occurrence_id: EvaluationExecution["subject_occurrence_id"];
  readonly extractor_version: string;
  readonly question_id: ProjectionInput["question"]["question_id"];
  readonly question_version: string;
  readonly projection_version: string;
  readonly privacy_classification: PrivacyClassification;
}
export interface ProjectedEvidenceReference {
  readonly ref: string;
  readonly kind?: EvidenceReference["kind"];
  readonly content: JsonValue | null;
  readonly digest: string | null;
  readonly is_redacted: boolean;
}
export interface ObservationInput {
  readonly question_text: string;
  readonly input_recipe: ProjectionInput["question"]["input_recipe"];
  readonly evidence_set: {
    readonly evidence_set_id: ProjectionInput["evidence"]["evidence_set_id"];
    readonly evidence_refs: readonly ProjectedEvidenceReference[];
    readonly is_incomplete: boolean;
    readonly incompleteness_reason: string | null;
  };
}
export interface ObservationOutput {
  readonly execution_id: EvaluationExecution["execution_id"];
  readonly status: EvaluationExecution["status"];
  readonly error: string | null;
  readonly model_usage: JsonValue | null;
  readonly cost: number | null;
}
export interface ProjectionShape {
  readonly trace: { readonly metadata: TraceMetadata };
  readonly observation: { readonly name: string; readonly input: ObservationInput; readonly output: ObservationOutput };
  readonly score_name: string;
}

function classification(kind: string, policy: ProjectionPolicy): PrivacyClassification {
  if (kind === "analysis" || kind === "plan" || kind === "brief" || kind === "assessment")
    return policy.body_sensitivity[kind];
  return "restricted";
}

function mayIncludeEvidence(reference: EvidenceReference, policy: ProjectionPolicy): boolean {
  switch (reference.kind) {
    case "public": return true;
    case "raw_build_output": return policy.allow_raw_build_output;
    case "raw_test_output": return policy.allow_raw_test_output;
    case "repository_content": return policy.allow_repository_content;
    default: return false;
  }
}

function projectEvidence(reference: EvidenceReference, policy: ProjectionPolicy): ProjectedEvidenceReference {
  const is_redacted = !mayIncludeEvidence(reference, policy) && reference.content !== null;
  return { ref: reference.ref, ...(reference.kind === undefined ? {} : { kind: reference.kind }),
    content: is_redacted ? null : reference.content, digest: reference.digest, is_redacted };
}

/** Encodes only pinned input; no current time, storage or provider access. */
export function encodeProjection(input: ProjectionInput): Result<ProjectionShape, LangfuseError> {
  const { execution, evidence, question, source, policy } = input;
  if (execution.evidence_set_id !== evidence.evidence_set_id)
    return err({ operation: "encode_projection", entity_id: execution.execution_id, detail: "execution and evidence set differ" });
  if (execution.question_id !== question.question_id || execution.question_version !== question.question_version)
    return err({ operation: "encode_projection", entity_id: execution.execution_id, detail: "execution and question differ" });
  if (input.question_text.trim().length === 0)
    return err({ operation: "encode_projection", entity_id: question.question_id, detail: "question text is empty" });
  const metadata: TraceMetadata = {
    producer: source.producer, namespace: source.namespace, run_id: source.run_id, unit_id: source.unit_id,
    artifact_kind: source.artifact_kind, revision_id: source.revision_id, revision_digest: source.revision_digest,
    ...(source.logical_item_id === null ? {} : { logical_item_id: source.logical_item_id }),
    occurrence_id: execution.subject_occurrence_id, extractor_version: source.extractor_version,
    question_id: question.question_id, question_version: question.question_version,
    projection_version: input.projection_version,
    privacy_classification: classification(source.artifact_kind, policy),
  };
  return ok({ trace: { metadata }, observation: {
    name: `${question.question_id}@${question.question_version}`,
    input: { question_text: input.question_text, input_recipe: question.input_recipe,
      evidence_set: { evidence_set_id: evidence.evidence_set_id,
        evidence_refs: evidence.references.map((reference) => projectEvidence(reference, policy)),
        is_incomplete: evidence.is_incomplete, incompleteness_reason: evidence.incompleteness_reason } },
    output: { execution_id: execution.execution_id, status: execution.status, error: execution.error,
      model_usage: execution.model_usage, cost: execution.cost },
  }, score_name: `${question.question_id}@${question.question_version}` });
}
