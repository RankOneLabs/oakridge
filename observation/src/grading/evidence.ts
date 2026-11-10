import { canonicalDigest } from "canonical-json";
import type { ArtifactRevisionId, EvaluatorDefinitionId, EvidenceSetId, ItemOccurrenceId, RunId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { QuestionKey } from "./question";

/** A line or inclusive line range cited within a repository file. */
export interface LineRange { readonly start: number; readonly end: number }

interface ReferenceFields {
  /** The label a grader sees this content under; unique within one evidence set. */
  readonly ref: string;
  readonly content: JsonValue;
}
/** Content copied from an exact captured revision, or from one item path within it. */
export interface RevisionEvidence extends ReferenceFields {
  readonly source: "revision";
  readonly revision_id: ArtifactRevisionId;
  readonly item_path: string | null;
}
/** A field of the run's captured launch input. */
export interface RunInputEvidence extends ReferenceFields {
  readonly source: "run_input";
  readonly run_id: RunId;
  readonly input_path: string;
}
/** A file read at an exact commit. A file missing at that commit is evidence, not a failed read. */
export interface RepositoryEvidence extends ReferenceFields {
  readonly source: "repository";
  readonly repository_key: string;
  readonly commit_sha: string;
  readonly path: string;
  readonly line_range: LineRange | null;
  readonly is_absent: boolean;
}
/** Text the producer's agent reported, at the exact revision and item path it was reported in.
 * It is passed through and never independently verified. */
export interface ReportedEvidence extends ReferenceFields {
  readonly source: "reported";
  readonly reported_by: "agent";
  readonly revision_id: ArtifactRevisionId;
  readonly item_path: string;
}
export type EvidenceReference = RevisionEvidence | RunInputEvidence | RepositoryEvidence | ReportedEvidence;

type JsonObject = { readonly [key: string]: JsonValue };
/** One reference as every provider is shown it, under its `ref`: the content together with its
 * source and exact provenance. A file missing at its commit says `is_absent: true` rather than
 * arriving as a bare null. */
export function providerEvidence(reference: EvidenceReference): JsonObject {
  switch (reference.source) {
    case "revision": return { source: reference.source, revision_id: reference.revision_id, item_path: reference.item_path,
      content: reference.content };
    case "run_input": return { source: reference.source, run_id: reference.run_id, input_path: reference.input_path,
      content: reference.content };
    case "repository": return { source: reference.source, repository_key: reference.repository_key, commit_sha: reference.commit_sha,
      path: reference.path, line_range: reference.line_range ? { start: reference.line_range.start, end: reference.line_range.end } : null,
      is_absent: reference.is_absent, content: reference.content };
    case "reported": return { source: reference.source, reported_by: reference.reported_by, revision_id: reference.revision_id,
      item_path: reference.item_path, content: reference.content };
  }
}

/** One question and the full evaluator set an occurrence of its item kind is pinned to when captured. */
export interface CapturePin extends QuestionKey {
  readonly item_kind: string;
  readonly evaluator_definition_ids: readonly EvaluatorDefinitionId[];
}
/** The configuration in force when an occurrence is captured. Later edits reach later captures. */
export interface CaptureConfiguration { readonly pins: readonly CapturePin[] }
export const NO_CAPTURE_PINS: CaptureConfiguration = { pins: [] };

/** Why one question cannot be collected yet. The question is retried when its input arrives. */
export interface NotReadyReason {
  readonly code: string;
  readonly detail: string;
}
export const COLLECTION_PENDING: NotReadyReason = { code: "collection_pending", detail: "evidence has not been collected yet" };

export type EvidenceReadiness =
  | { readonly state: "not_ready"; readonly reason: NotReadyReason }
  | { readonly state: "ready"; readonly references: readonly EvidenceReference[]; readonly ready_at: Date };

/** Mirrors observation.evidence_set: the capture pin, its readiness and its frozen references. */
export interface EvidenceSet extends QuestionKey {
  readonly evidence_set_id: EvidenceSetId;
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly pinned_evaluator_definition_ids: readonly EvaluatorDefinitionId[];
  readonly readiness: EvidenceReadiness;
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}
/** The evidence an evaluator is given. Only ready evidence reaches a grader. */
export interface ReadyEvidence {
  readonly evidence_set_id: EvidenceSetId;
  readonly references: readonly EvidenceReference[];
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}

export interface EvidenceIdError { readonly operation: "evidence_set_id"; readonly entity_id: string; readonly detail: string }
/** One evidence set exists per occurrence and question version, whatever its content becomes. */
export function evidenceSetId(subject_occurrence_id: ItemOccurrenceId, question: QuestionKey): Result<EvidenceSetId, EvidenceIdError> {
  const digest = canonicalDigest([subject_occurrence_id, question.question_id, question.question_version]);
  return digest.ok ? ok(digest.value as unknown as EvidenceSetId)
    : err({ operation: "evidence_set_id", entity_id: subject_occurrence_id, detail: digest.error.detail });
}
