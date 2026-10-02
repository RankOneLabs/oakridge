import type { ArtifactId, AttemptId, CohortId, JsonValue, ProjectId, Result, StageInstanceId, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../domain/primitives";
import type { PromptBundle, StageInstance, WorkflowDefinition } from "../domain/workflow";
import type { CollaborationMessage, CollaborationThread, CollaborationThreadWithMessages, MessageId, ThreadId, ThreadStatus } from "../domain/collaboration";
import type { ArtifactCoordinate, ArtifactRevision } from "../domain/artifacts";
import type { SessionHold } from "../domain/session-hold";
import type { OperatorSessionRunLocation } from "../domain/operator-projections";
import type { CreateProject, Project, UpdateProject } from "../domain/projects";
import type { CreateWorkflowRunResult, DeleteRunResult, PersistWorkflowRunLaunch, SetRunArchiveResult, UnstartedRun, WorkflowRunLaunchRecord, WorkflowRunListFilter } from "../domain/runs";
import type { DevFlowBuildCohort } from "../domain/cohort-pull-request";
import type { PullRequest, PullRequestId, PullRequestMergeClosure, PullRequestObservation, PullRequestObservationId, PullRequestVerificationId, StoredPullRequestObservation } from "../domain/pull-request";
import type { WorkflowRunRecord } from "../domain/records";
import type {
  AttemptExecution,
  BindSessionResult,
  BindSession,
  CohortLaunchCommitted,
  CohortLaunchCommitError,
  CommitCohortLaunch,
  CancelRunRecord,
  CancelRunRecordResult,
  CloseRunOutputWaitResult,
  CohortMachineState,
  DecideGateWait,
  GateDecisionRecord,
  InitializeRun,
  InitializeRunResult,
  ObserveSession,
  OpenStageCohorts,
  OpenStageCohortsResult,
  PublishWorkOrderArtifact,
  PublishWorkOrderArtifactResult,
  RecordCohortEvent,
  RecordCohortEventResult,
  SessionStatusWrite,
  RunDecision,
  RunRecordRepositoryError,
  StageRosterError,
  StartAttempt,
  StartAttemptResult,
} from "../domain/run-record";

export interface WorkflowDefinitionRepository {
  insert_immutable(definition: WorkflowDefinition, prompt_bundle: PromptBundle): Promise<WorkflowDefinition>;
  find_by_id(id: WorkflowDefinitionId): Promise<WorkflowDefinition | null>;
  find_by_name_version(name: string, version: number): Promise<WorkflowDefinition | null>;
  list(include_archived?: boolean): Promise<readonly WorkflowDefinition[]>;
  set_archived(id: WorkflowDefinitionId, archived: boolean): Promise<WorkflowDefinition | null>;
}

export interface PromptBundleRepository {
  insert_prompt_bundle(bundle: PromptBundle): Promise<PromptBundle>;
  bind_prompt_bundle(definition_id: WorkflowDefinitionId, hash: string): Promise<void>;
  find_prompt_bundle(hash: string): Promise<PromptBundle | null>;
  find_bound_prompt_bundle(definition_id: WorkflowDefinitionId): Promise<PromptBundle | null>;
}

export interface ProjectRepository {
  insert(project: CreateProject): Promise<Project>;
  update(id: ProjectId, project: UpdateProject): Promise<Project | null>;
  list(): Promise<readonly Project[]>;
  find_by_id(id: ProjectId): Promise<Project | null>;
}

export interface WorkflowRunRepository {
  find_by_id(id: WorkflowRunId): Promise<WorkflowRunRecord | null>;
  create_run(input: PersistWorkflowRunLaunch): Promise<CreateWorkflowRunResult>;
  find_launch_by_id(id: WorkflowRunId): Promise<WorkflowRunLaunchRecord | null>;
  list(filter?: WorkflowRunListFilter): Promise<readonly WorkflowRunLaunchRecord[]>;
  set_archived(id: WorkflowRunId, archived: boolean): Promise<SetRunArchiveResult>;
  /** An unfinished run with no `dbos.workflow_status` row for its derived root workflow id — the sweep's launch candidates. */
  list_unstarted_runs(limit: number): Promise<readonly UnstartedRun[]>;
}

/**
 * The single transactional boundary the v15 topology and the operator surface
 * ask for run truth.
 *
 * Every write here commits its owner's status change, that owner's version
 * bump, and the transition recording the effect, in one transaction — so a
 * caller never observes a status without the transition that explains it, and a
 * replayed dispatch always lands on the same `effect_workflow_id`.
 */
export interface RunRecordRepository {
  /** Opens the run's stage instances from its compiled graph. Idempotent. */
  initialize_run(input: InitializeRun): Promise<InitializeRunResult>;
  /** Load, derive and commit one whole-run decision. The run machine's only step. */
  decide_run(run_id: WorkflowRunId, decided_at: string): Promise<Result<RunDecision, RunRecordRepositoryError>>;
  /** Materializes a started stage's cohorts and their declared output slots. Idempotent. */
  open_stage_cohorts(input: OpenStageCohorts): Promise<OpenStageCohortsResult>;
  fail_stage_roster(stage_instance_id: StageInstanceId, detail: string, failed_at: string): Promise<Result<void, StageRosterError>>;
  /** Commits an adapter's cohort decision under the cohort's own durable version. */
  record_cohort_event(input: RecordCohortEvent): Promise<RecordCohortEventResult>;
  commit_cohort_launch(input: CommitCohortLaunch): Promise<Result<CohortLaunchCommitted, CohortLaunchCommitError>>;
  /** What a cohort machine reads before applying its next event. */
  find_cohort_state(cohort_id: CohortId): Promise<CohortMachineState | null>;
  list_stage_cohort_ids(stage_instance_id: StageInstanceId): Promise<readonly CohortId[]>;
  /** The attempt and session a committed launch transition names. Idempotent on the attempt number. */
  start_attempt(input: StartAttempt): Promise<StartAttemptResult>;
  find_attempt_execution(attempt_id: AttemptId): Promise<AttemptExecution | null>;
  /** Records the adapter handle an ensured session is addressed by. */
  bind_session(input: BindSession): Promise<BindSessionResult>;
  /** The session's own lifecycle, and its attempt's, from what the adapter reported. */
  observe_session(input: ObserveSession): Promise<SessionStatusWrite>;
  mark_session_fenced(session_id: import("../domain/primitives").SessionId, fenced_at: string): Promise<void>;
  list_prior_sessions_to_fence(cohort_id: CohortId, attempt_id: AttemptId): Promise<readonly import("../domain/run-record").PriorSessionToFence[]>;
  find_cohort_retry_claim(cohort_id: CohortId, idempotency_key: string): Promise<{
    readonly attempt_id: AttemptId; readonly attempt_number: number; readonly durable_version: number } | null>;
  /** The secret every attempt's publication capability is derived from. */
  load_work_order_capability_seed(): Promise<string>;
  /**
   * Records an artifact under an attempt's capability, atomically with the
   * effect its declared release policy has on the slot: an `immediate` output
   * is accepted directly; a `gate` or `handoff` output is recorded and its slot
   * parked pending the wait that will decide it.
   */
  publish_artifact(request: PublishWorkOrderArtifact): Promise<PublishWorkOrderArtifactResult>;
  /** Decides an operator gate, releasing or invalidating the slots it holds. */
  decide_gate_wait(request: DecideGateWait): Promise<CloseRunOutputWaitResult>;
  find_cohort_location(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<{
    readonly run_id: WorkflowRunId; readonly cohort_id: CohortId; readonly status: import("../domain/records").CoreStatus;
  } | null>;
  cancel_run(input: CancelRunRecord): Promise<CancelRunRecordResult>;
  delete_run(run_id: WorkflowRunId): Promise<DeleteRunResult>;
}

export interface StageInstanceRepository {
  find_by_id(id: StageInstanceId): Promise<StageInstance | null>;
  /** The pinned contract a stage was opened with, as the topology reads it back. */
  find_contract(id: StageInstanceId): Promise<{ readonly run_id: WorkflowRunId; readonly stage_key: string; readonly stage_contract: JsonValue } | null>;
}

export interface ArtifactRevisionRepository {
  find_current(coordinate: ArtifactCoordinate): Promise<ArtifactRevision | null>;
  list_chain(chain_id: ArtifactId): Promise<readonly ArtifactRevision[]>;
  find_by_id(id: ArtifactId): Promise<ArtifactRevision | null>;
}

export interface RunArtifactReadRepository {
  list_effective_for_run(run_id: WorkflowRunId): Promise<readonly ArtifactRevision[]>;
  /** Accepted, released revisions of one stage's declared output — a downstream stage's inputs. */
  list_released_for_stage_output(stage_instance_id: StageInstanceId, output_name: string): Promise<readonly ArtifactRevision[]>;
}

/**
 * How a decided gate labelled one revision. Replaces v14's
 * `GateDecisionAuditRepository`, whose only production reader was this label —
 * v15 records the decision on `wait_gate.outcome` and the transition ledger,
 * so there was no second fact left for a table to hold.
 */
export interface GateDecisionReadRepository {
  find_for_revision(artifact_revision_id: ArtifactId): Promise<GateDecisionRecord | null>;
}

export interface SessionHoldRepository {
  /** The live execution holding this agent session, if any. */
  find_session_hold(session_id: string): Promise<SessionHold | null>;
}

/**
 * Where a session sits in the run graph — a navigation read, deliberately
 * separate from `SessionHoldRepository`.
 *
 * `find_session_hold` answers close-safety, and its predicates (an unfinished
 * attempt whose workflow is PENDING/SUCCESS) *are* those semantics. Loosening
 * them so a finished session still resolved to its run would make kbbl refuse
 * to close sessions that are safe to close. So navigation gets its own
 * unconditional lookup rather than a widened hold.
 */
export interface SessionRunLocationRepository {
  /** The run, stage and cohort this session's attempt belongs to — whatever state that work reached. */
  find_run_for_session(session_id: string): Promise<OperatorSessionRunLocation | null>;
}

export interface CurrentVerifiedCohortPullRequest {
  readonly cohort: DevFlowBuildCohort;
  readonly pull_request: PullRequest;
  readonly observation: StoredPullRequestObservation;
}

/** Storage boundary shared by cohort and final-stage adapters. */
export interface DevFlowPullRequestRepository {
  create_cohort(cohort: DevFlowBuildCohort): Promise<Result<DevFlowBuildCohort,
    { readonly kind: "cohort_not_stored" | "identity_conflict" | "storage_failed"; readonly detail: string }>>;
  begin_cohort_advance(input: { readonly cohort_id: CohortId; readonly expected_head_sha: string; readonly next_head_sha: string; readonly prepared_at: string }): Promise<Result<void, { readonly kind: "cohort_not_found" | "ref_lease_mismatch"; readonly detail: string }>>;
  advance_cohort_head(input: { readonly cohort_id: CohortId; readonly expected_head_sha: string; readonly next_head_sha: string; readonly advanced_at: string }): Promise<Result<DevFlowBuildCohort, { readonly kind: "cohort_not_found" | "ref_lease_mismatch"; readonly detail: string }>>;
  find_cohort_for_unit(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<DevFlowBuildCohort | null>;
  find_current_for_unit(stage_instance_id: StageInstanceId, unit_id: UnitId): Promise<CurrentVerifiedCohortPullRequest | null>;
  observe(input: { readonly observation: PullRequestObservation; readonly recorded_at: string }): Promise<{ readonly pull_request_id: PullRequestId; readonly observation_id: PullRequestObservationId }>;
  bind_verified(input: { readonly cohort_id: CohortId; readonly pull_request_id: PullRequestId; readonly observation_id: PullRequestObservationId; readonly verified_head_sha: string; readonly verified_at: string; readonly replace_verification_id: PullRequestVerificationId | null }): Promise<Result<{ readonly id: PullRequestVerificationId; readonly binding: "created" | "replaced" | "head_advanced" }, { readonly kind: "replacement_required" | "replacement_conflict" | "build_cohort_not_found"; readonly detail: string }>>;
  confirm_merge(input: { readonly cohort_id: CohortId; readonly pull_request_id: PullRequestId; readonly idempotency_key: string; readonly merged_at: string; readonly confirmed_at: string }): Promise<Result<{ readonly kind: "created" | "replayed"; readonly closure: PullRequestMergeClosure }, { readonly kind: "idempotency_conflict" | "pull_request_not_current" | "missing_merged_evidence"; readonly detail: string }>>;
}

/**
 * Artifact-anchored review discussion — `oakridge.artifact_thread` and its
 * messages.
 *
 * Review items are gone: exactly one artifact type ever declared the
 * capability, no gate has ever enforced `requires_zero_open_review_items` (not
 * in v15 and not in v14 either), and threads cover commenting on every type the
 * operator surface exposes.
 */
export interface CollaborationRepository {
  insert_thread_with_message(thread: CollaborationThread, message: CollaborationMessage): Promise<{ readonly thread_id: ThreadId; readonly message_id: MessageId }>;
  insert_thread(thread: CollaborationThread): Promise<ThreadId>;
  insert_message(message: CollaborationMessage): Promise<MessageId>;
  find_thread(id: ThreadId): Promise<CollaborationThread | null>;
  list_threads(chain_id: ArtifactId): Promise<readonly CollaborationThreadWithMessages[]>;
  update_thread_status(id: ThreadId, status: ThreadStatus): Promise<void>;
}

/**
 * What the final epic pull request for one repository is opened against.
 *
 * Read from the run context rather than a profile row: the epic's
 * `forge_repository` and `final_merge_policy` live there now, and the cohort
 * itself is 0016's `dev_flow_build_cohort`.
 */
export interface ForgeRepositoryRepository {
  find_forge_repository(run_id: WorkflowRunId, repository_key: string): Promise<{ readonly owner: string; readonly name: string } | null>;
}
