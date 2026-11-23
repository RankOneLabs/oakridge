// Artifacts, review gates, cohort merges and the review inbox on the operator surface.

import type { RepositoryKey, RunState, WorktreeMetadata } from "./run-types";
import type { OperatorDecisionDefinition } from "./operator-contracts/projections/unit-view";
export interface ArtifactRevision {
  context?: import("./lib/current-context").CurrentArtifactContext;
  received_context?: import("./lib/received-context").ReceivedContext | null;
  subject_revision_id?: string | null;
  producing_attempt_inputs?: unknown;
  artifact_schema_version?: string | null;
  component_id?: string | null;
  id: string;
  status: ArtifactRevisionStatus;
  created_at: string;
  body: unknown;
  validation: unknown;
}

/** Mirrors the revision status returned by the artifact API. */
export type ArtifactRevisionStatus = "draft" | "approved" | "rejected";

/** Mirrors `issue.severity` in workflow-config/development.yaml. */
export type FindingSeverity = "blocking" | "warning" | "info";

/** Mirrors `spec_requirement.status` in workflow-config/development.yaml. */
export type RequirementStatus = "implementable" | "blocked" | "ambiguous";

/** Mirrors `assessment_body.verdict` in workflow-config/development.yaml. */
export type AssessmentVerdict = "pass" | "pass_with_notes" | "fail";

/** Mirrors `assessment_finding.status` in workflow-config/development.yaml. */
export type CriterionStatus = "met" | "not_met" | "partial";

/** Mirrors `pr_body.review_status` in workflow-config/development.yaml. */
export type PrReviewStatus = "draft" | "ready" | "changes_requested" | "approved" | "merged" | "closed";

export interface ArtifactCapabilities {
  reviewable: boolean;
  commentable: boolean;
  atom_editable: boolean;
  review_items: boolean;
}

export interface ArtifactReviewDescriptor {
  viewer: string;
  layout: "document" | "dag" | "report";
  sections: string[];
}

export interface ArtifactTypeDescriptor {
  id: string;
  component_id: string;
  capabilities: ArtifactCapabilities;
  anchor_schema: string[] | null;
  review?: ArtifactReviewDescriptor | null;
}

/**
 * Where an artifact lives: its run, and its unit label (a cohort id for
 * per-cohort artifacts), as of the revision being viewed.
 */
export interface ArtifactSource {
  run_id: string;
  /** Identity of the revision on screen. */
  revision_id: string;
  label: string | null;
  producing_stage?: string;
  producing_attempt_inputs?: unknown;
  /** `created_at` of the revision on screen; sibling artifacts are read as they stood then. */
  as_of: string;
}

export interface ArtifactDetail {
  link_field?: string | null;
  proposal_paths?: readonly (readonly import("./operator-contracts/core-client/core-types").OperatorPathSegment[])[];
  projected_workers?: readonly import("./operator-contracts/projections/unit-view").OperatorProjectedWorker[];
  projected_schemas?: readonly import("./operator-contracts/projections/schema-view").OperatorSchema[];
  schema?: string;
  artifact_schema_version?: string | null;
  context?: import("./lib/current-context").CurrentArtifactContext;
  received_context?: import("./lib/received-context").ReceivedContext | null;
  id: string;
  type_id: string;
  component_id: string | null;
  capabilities: ArtifactCapabilities | null;
  anchor_schema: string[] | null;
  review?: ArtifactReviewDescriptor | null;
  run_id: string;
  producing_attempt_inputs?: unknown;
  producing_stage: string;
  label?: string | null;
  revisions: ArtifactRevision[];
}

export interface ParkedGate {
  requires_adjudication?: boolean;
  /** The validator's message when it rejected a revision the review decides, so Accept is withheld. */
  validation_rejection?: string | null;
  blocker?: import("./operator-contracts/projections/history-view").OperatorBlockerHistory | null;
  requirement_ids?: readonly string[];
  id: string;
  gate_type: string;
  gate_step: string | null;
  reviewed_revision_id?: string;
  session_id?: string | null;
  producer_labels?: readonly string[];
  run_id: string;
  stage_name: string;
  unit_id: string;
  repository_key?: RepositoryKey | null;
  artifact_revision_id: string | null;
  assessment_revision_id?: string | null;
  worktree: WorktreeMetadata | null;
  resume_actions: string[];
  /** Full server offer, including decisions hidden from the generic resume buttons. */
  offered_decisions: string[];
  /** Server definitions preserve each decision's declared fields and availability. */
  decision_definitions?: readonly OperatorDecisionDefinition[];
  pr_url?: string | null;
  /** The run's persisted state at read time — a gate stays listed whatever it is. */
  run_state: RunState;
  /** Whether a decision on this gate can still take effect. `false` means the run moved on (or ended) while the gate sat open — render it stranded. */
  actionable: boolean;
}

/**
 * Changes the operator requested on a unit, shown until the agent publishes a
 * revision that replaces the one they targeted. Mirrors one
 * `request_changes` entry of the unit view's `recorded_decisions`.
 */
export interface SentReviewFeedback {
  id: string;
  target_revision_id: string;
  run_id: string;
  stage_name: string;
  unit_id: string;
  review: string;
  decision: string;
  feedback: string | null;
  sent_at: string;
}

export interface GateResumeRequest {
  idempotency_key: string;
  artifact_revision_id: string;
  action: string;
  feedback: string;
}

export interface GateResumeResponse {
  gate_id: string;
  resumed: boolean;
}

/** Live PR observation returned by the merge-status operator endpoint. */
export type MergeStatus =
  | { readonly kind: "merged"; readonly pr_url: string; readonly merged_at: string | null }
  | { readonly kind: "not_merged"; readonly pr_url: string; readonly state: "open" | "closed_unmerged" }
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * The operator confirming a cohort's pull request merged, when Oakridge cannot
 * see the repository for itself. Mirrors the `operator_confirmation` half of
 * `POST /cohorts/:cohortId/pull_request` in oakridge-dbos.
 */
export interface ConfirmCohortMergedRequest {
  idempotency_key: string;
  operator_comment: string;
}

export type CohortPullRequestOutcomeKind =
  | "completed"
  | "already_completed"
  | "merged_not_awaiting"
  | "waiting"
  | "ignored_stale";

export interface CohortPullRequestResponse {
  cohort_id: string;
  outcome: { kind: CohortPullRequestOutcomeKind };
}

export type CohortLifecycle =
  | "building"
  | "artifact_review"
  | "revision_requested"
  | "merge_review"
  | "assessing"
  | "github_review"
  | "pull_request_mismatch"
  | "complete"
  | "failed";

export interface CohortCompletion {
  build_complete: boolean;
  assessment_complete: boolean;
}

export interface CohortLifecycleSummary {
  id: string;
  run_id: string;
  workflow_name: string;
  stage_instance_id: string;
  stage_name: string;
  unit_id: string;
  cohort_key: string | null;
  brief_title: string | null;
  repository_key: RepositoryKey;
  title?: string | null;
  run_title?: string | null;
  lifecycle: CohortLifecycle;
  completion: CohortCompletion;
  artifact_revision_id?: string | null;
  artifact_url?: string | null;
  gate_id?: string | null;
  gate_url?: string | null;
  pr_url?: string | null;
  pull_request_reconciliation?: CohortPullRequestReconciliation | null;
  updated_at: string;
}

export type ReviewInboxItemKind =
  | "artifact_gate"
  | "merge_review"
  | "cohort_blocked"
  | "cohort_failed"
  | "pull_request_mismatch"
  | "pull_request_merge"
  | "gate_decision"
  /** A worker parked on a blocker that needs the operator's answer, given in the unit's pane. */
  | "blocker";

export type ReviewInboxItemState = "actionable" | "blocked";

export interface ReviewInboxItem {
  readonly gate?: ParkedGate;
  id: string;
  kind: ReviewInboxItemKind;
  state: ReviewInboxItemState;
  run_id: string;
  workflow_name: string;
  stage_instance_id: string;
  stage_name: string;
  unit_id: string;
  cohort_key: string | null;
  brief_title: string | null;
  repository_key: RepositoryKey | null;
  lifecycle: CohortLifecycle;
  title?: string | null;
  run_title?: string | null;
  artifact_key?: string | null;
  artifact_revision_id?: string | null;
  artifact_url?: string | null;
  gate_id?: string | null;
  gate_url?: string | null;
  resume_actions: string[];
  /** The review's decisions carry an adjudication payload, recorded from the assessment view rather than inbox controls. */
  requires_adjudication?: boolean;
  /** The validator's message when it rejected a revision the review decides, so Accept is withheld. */
  validation_rejection?: string | null;
  blocked_by: string[];
  pr_url?: string | null;
  /** The unit's authority id, which opens its pane in the run. */
  run_unit_id?: string | null;
}

/** The items list is the required-attention decision queue; completed and optional-attention history lives outside the inbox. */
export interface ReviewInbox {
  cohorts: CohortLifecycleSummary[];
  items: ReviewInboxItem[];
}

export interface PullRequestObservation {
  owner: string;
  name: string;
  number: number;
  url: string;
  head_branch: string;
  base_branch: string;
  state: "open" | "merged" | "closed_unmerged";
  observed_at: string;
}

export interface PullRequestMismatch {
  kind: "missing_repository_identity" | "repository_mismatch" | "pull_request_mismatch" | "head_branch_mismatch" | "base_branch_mismatch" | "closed_without_merge" | "stale_observation";
  detail: string;
}

export interface CohortPullRequestReconciliation {
  repository_key: RepositoryKey;
  observation: PullRequestObservation;
  mismatch: PullRequestMismatch | null;
  completed_at: string | null;
  updated_at: string;
}

// Definition declarations, distinct from run ArtifactDetail and revision bodies.
export type ArtifactConsumer =
  | { kind: "review_of"; review: string }
  | { kind: "review_input"; review: string; input: string }
  | { kind: "worker_input"; worker: string; input: string }
  | { kind: "evaluates"; worker: string }
  | { kind: "let"; name: string }
  | { kind: "outcome"; name: string };
export interface ArtifactContract {
  name: string;
  kind: import("./operator-contracts/core-client/core-types").OperatorArtifactKind;
  schema: import("./operator-contracts/core-client/core-types").OperatorType;
  required_fields: string[] | null;
  validate: import("./operator-contracts/core-client/core-types").OperatorParsedArtifact["validate"];
  producers: string[];
  consumers: ArtifactConsumer[];
  producer_prompts: import("./lib/prompt-inspector").PromptRow[];
}
