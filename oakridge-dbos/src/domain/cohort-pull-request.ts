/** Prepared repository identity and independently verified PR facts. */
import type { ArtifactId, CohortId, StageInstanceId, UnitId, WorkflowRunId } from "./primitives";
import type { PullRequestVerificationId } from "./pull-request";
import type { FinalIntegrationCohortRecord, VerifiedPrObservation } from "./dev-flow-v15";
import {
  type PullRequestMismatch, type PullRequestObservation,
} from "./pull-request";

/** Final PR branch roles are adapter-owned facts from the prepared repository. */
export const finalPullRequestMatchesPreparedRepository = (
  cohort: FinalIntegrationCohortRecord, pr: VerifiedPrObservation | null,
): boolean => pr !== null && pr.repository_key === cohort.inputs.repository.repository_key
  && pr.head_branch === cohort.inputs.repository.base_branch
  && pr.base_branch === cohort.inputs.repository.integration_branch;

/**
 * Adapter-owned build identity. `cohort_key` is unique only inside its stage;
 * the repository and both branch roles are persisted once and reused by the
 * prompt and PR verifier.
 */
export interface CohortRepositoryRecord {
  readonly cohort_id: CohortId;
  readonly stage_instance_id: StageInstanceId;
  readonly cohort_key: string;
  readonly repository_key: string;
  readonly repository_path: string;
  readonly canonical_ref: string;
  readonly expected_pr_base: string;
  readonly recorded_head_sha: string;
  readonly current_verified_pull_request_id: PullRequestVerificationId | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CohortPullRequestReconciliation {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly repository_key: string;
  /** Null only for rows written before handoff identity was persisted. */
  readonly handoff_artifact_id: ArtifactId | null;
  readonly observation: PullRequestObservation;
  readonly mismatch: PullRequestMismatch | null;
  readonly completed_at: string | null;
  readonly updated_at: string;
}

/**
 * What the run should do with an observation.
 *
 * `merged` is the only outcome that completes the external wait. `waiting` is a
 * pull request that is genuinely still open — not an error, just not yet.
 */
export type CohortPullRequestOutcome =
  | { readonly kind: "merged" }
  | { readonly kind: "waiting" }
  | { readonly kind: "already_completed" }
  | { readonly kind: "mismatch"; readonly mismatch: PullRequestMismatch }
  | { readonly kind: "ignored_stale"; readonly mismatch: PullRequestMismatch };

/** Forge and origin evidence read by the implementation publication boundary. */
export interface ImplementationPublicationEvidence {
  readonly pr: PullRequestObservation;
  readonly origin_head_sha: string;
  readonly replace_verification_id: PullRequestVerificationId | null;
}

/** Preparation failures are observations; uncertain IO remains recoverable. */
export interface CohortPreparationError {
  readonly operation: "prepare_cohort_repository";
  readonly cohort_id: import("./primitives").CohortId;
  readonly kind: "invalid_repository" | "unavailable";
  readonly detail: string;
}
