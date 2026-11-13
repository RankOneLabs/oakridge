// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationArtifactRevisionId, ObservationEvaluatorDefinitionId, ObservationEvidenceSetId, ObservationItemOccurrenceId, ObservationLogicalItemId, ObservationRunId } from "../domain/identity";
import type { ObservationJsonValue } from "../domain/primitives";
import type { ObservationQuestionKey } from "./question";

export type ObservationEvidenceReference = ObservationRevisionEvidence | ObservationRunInputEvidence | ObservationRepositoryEvidence | ObservationReportedEvidence;

export interface ObservationEvidenceSet extends ObservationQuestionKey {
  readonly evidence_set_id: ObservationEvidenceSetId;
  readonly subject_occurrence_id: ObservationItemOccurrenceId;
  readonly task_id: ObservationLogicalItemId | null;
  readonly pinned_evaluator_definition_ids: readonly ObservationEvaluatorDefinitionId[];
  readonly readiness: ObservationEvidenceReadiness;
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}

export interface ObservationRevisionEvidence extends ObservationReferenceFields {
  readonly source: "revision";
  readonly revision_id: ObservationArtifactRevisionId;
  readonly item_path: string | null;
}

export interface ObservationRunInputEvidence extends ObservationReferenceFields {
  readonly source: "run_input";
  readonly run_id: ObservationRunId;
  readonly input_path: string;
}

export interface ObservationRepositoryEvidence extends ObservationReferenceFields {
  readonly source: "repository";
  readonly repository_key: string;
  readonly commit_sha: string;
  readonly path: string;
  readonly line_range: ObservationLineRange | null;
  readonly is_absent: boolean;
  readonly is_binary: boolean;
  /** The size in bytes of a binary file; null for a text or absent file. */
  readonly byte_size: number | null;
}

export interface ObservationReportedEvidence extends ObservationReferenceFields {
  readonly source: "reported";
  readonly reported_by: "agent";
  readonly revision_id: ObservationArtifactRevisionId;
  readonly item_path: string;
}

export type ObservationEvidenceReadiness =
  | { readonly state: "not_ready"; readonly reason: ObservationNotReadyReason }
  | { readonly state: "ready"; readonly references: readonly ObservationEvidenceReference[]; readonly ready_at: string };

export interface ObservationReferenceFields {
  /** The label a grader sees this content under; unique within one evidence set. */
  readonly ref: string;
  readonly content: ObservationJsonValue;
}

export interface ObservationLineRange { readonly start: number; readonly end: number }

export interface ObservationNotReadyReason {
  readonly code: string;
  readonly detail: string;
}
