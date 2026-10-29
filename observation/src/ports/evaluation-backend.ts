import type { ArtifactRevisionId, CanonicalDigest, ItemOccurrenceId, QuestionId, RunId } from "../domain/identity";
import { err, type Brand, type JsonValue, type Result } from "../domain/primitives";
import type { EvidenceSet } from "../grading/evidence";
import type { EvaluationExecution } from "../grading/execution";
import type { QuestionDefinition } from "../grading/question";
import type { LangfuseSyncState } from "../langfuse/sync-state";

export interface LangfuseError { readonly operation: string; readonly entity_id: string; readonly detail: string }
export type LangfuseTraceId = Brand<string, "LangfuseTraceId">;
export type LangfuseObservationId = Brand<string, "LangfuseObservationId">;
export type LangfuseScoreId = Brand<string, "LangfuseScoreId">;
export type LangfuseQueueItemId = Brand<string, "LangfuseQueueItemId">;
export type ObservationUnitId = Brand<string, "ObservationUnitId">;
export type LogicalItemId = Brand<string, "ObservationLogicalItemId">;

export type PrivacyClassification = "public" | "internal" | "restricted";
export interface ProjectionPolicy {
  /** Classification of each artifact body; all other kinds are restricted. */
  readonly body_sensitivity: {
    readonly analysis: PrivacyClassification;
    readonly plan: PrivacyClassification;
    readonly brief: PrivacyClassification;
    readonly assessment: PrivacyClassification;
  };
  readonly allow_raw_build_output: boolean;
  readonly allow_raw_test_output: boolean;
  readonly allow_repository_content: boolean;
}
export interface ProjectionSource {
  readonly producer: string;
  readonly namespace: string;
  readonly run_id: RunId;
  readonly unit_id: ObservationUnitId | null;
  readonly artifact_kind: string;
  readonly revision_id: ArtifactRevisionId;
  readonly revision_digest: CanonicalDigest;
  readonly logical_item_id: LogicalItemId | null;
  readonly extractor_version: string;
}
export interface ProjectionInput {
  readonly execution: EvaluationExecution;
  readonly evidence: EvidenceSet;
  readonly question: QuestionDefinition;
  /** The pinned question wording; QuestionDefinition currently stores only its input recipe. */
  readonly question_text: string;
  readonly source: ProjectionSource;
  readonly policy: ProjectionPolicy;
  readonly projection_version: string;
}
export interface ExternalTargetIds {
  readonly trace_id: LangfuseTraceId;
  readonly observation_id: LangfuseObservationId;
  readonly score_id: LangfuseScoreId;
  readonly queue_item_id: LangfuseQueueItemId;
}
export interface LangfuseScore {
  readonly score_id: LangfuseScoreId;
  readonly observation_id: LangfuseObservationId;
  readonly name: string;
  readonly value: number | string | boolean;
  readonly comment: string | null;
  readonly updated_at: string;
}
export type LangfuseAnnotationOutcome =
  | { readonly status: "pending"; readonly queue_item_id: LangfuseQueueItemId }
  | { readonly status: "completed"; readonly queue_item_id: LangfuseQueueItemId; readonly score_id: LangfuseScoreId;
      readonly value: JsonValue; readonly reviewer_id: string | null; readonly completed_at: string };
export interface InboundEvaluation {
  readonly scores: readonly LangfuseScore[];
  readonly annotation_outcomes: readonly LangfuseAnnotationOutcome[];
}
export interface FetchSelector { readonly mapping_key: CanonicalDigest; readonly external_ids: ExternalTargetIds }
export interface ReconcileSelector {
  readonly mapping_key: CanonicalDigest;
  readonly occurrence_id: ItemOccurrenceId;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly external_ids: ExternalTargetIds | null;
}
export interface ReconcileOutcome {
  readonly external_ids: ExternalTargetIds | null;
  readonly inbound: InboundEvaluation;
  readonly sync_state: LangfuseSyncState;
}

/** A written target has its trace and observation; its score and queue item arrive later. */
export type ProjectionOutcome =
  | { readonly status: "written"; readonly trace_id: LangfuseTraceId; readonly observation_id: LangfuseObservationId }
  | { readonly status: "complete"; readonly external_ids: ExternalTargetIds };

/** Optional external mirror. The local grading store remains authoritative. */
export interface EvaluationBackend {
  project(input: ProjectionInput): Promise<Result<ProjectionOutcome, LangfuseError>>;
  fetch(selector: FetchSelector): Promise<Result<InboundEvaluation, LangfuseError>>;
  reconcile(selector: ReconcileSelector): Promise<Result<ReconcileOutcome, LangfuseError>>;
}

/** Offline mode makes absence explicit without affecting local capture or grading. */
export class LocalEvaluationBackend implements EvaluationBackend {
  async project(input: ProjectionInput): Promise<Result<ProjectionOutcome, LangfuseError>> {
    return err({ operation: "project", entity_id: input.execution.execution_id, detail: "Langfuse adapter is disabled" });
  }
  async fetch(selector: FetchSelector): Promise<Result<InboundEvaluation, LangfuseError>> {
    return err({ operation: "fetch", entity_id: selector.mapping_key, detail: "Langfuse adapter is disabled" });
  }
  async reconcile(selector: ReconcileSelector): Promise<Result<ReconcileOutcome, LangfuseError>> {
    return err({ operation: "reconcile", entity_id: selector.mapping_key, detail: "Langfuse adapter is disabled" });
  }
}
