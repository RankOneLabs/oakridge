import type { OutputAttention, OutputReleaseContract } from "./compiled-workflow";
import type { ArtifactEnvelope, ExecutionRequest, ExecutorTerminalObservation, ExternalExecutionReference } from "./execution";
import type { BlockedReason, CoreStatus, NextActor } from "./records";
import type {
  ArtifactId,
  AttemptId,
  CohortId,
  JsonValue,
  KbblSessionId,
  OutputCollectionKey,
  RunRecordVersion,
  RunTransitionId,
  SessionId,
  StageInstanceId,
  WaitId,
  WorkflowDefinitionId,
  WorkflowRunId,
} from "./primitives";
import type { ArtifactTypeId, StageKey, StageOutcome, WorkflowRunBundlePin } from "./workflow";

export type TransitionLaunchReason = "initial" | "dependency_satisfied" | "artifact_accepted" | "gate_decided" | "operator" | "retry" | "recovery";
export type TransitionOwner =
  | { readonly kind: "run"; readonly id: WorkflowRunId }
  | { readonly kind: "stage_instance"; readonly id: StageInstanceId }
  | { readonly kind: "cohort"; readonly id: CohortId };

/**
 * A durable effect selected by core or an adapter. The name is validated by
 * the application registry before a transition is committed; keeping it out
 * of a SQL enum/check lets adapters add effects without a core migration.
 */
export interface TransitionEffectDescriptor {
  readonly kind: string;
  readonly [key: string]: JsonValue;
}

/** Named row type for oakridge.run_transition. */
export interface RunTransitionRecord {
  readonly id: RunTransitionId;
  readonly sequence: string;
  readonly run_id: WorkflowRunId;
  readonly owner_kind: TransitionOwner["kind"];
  readonly owner_run_id: WorkflowRunId | null;
  readonly owner_stage_instance_id: StageInstanceId | null;
  readonly owner_cohort_id: CohortId | null;
  readonly launch_reason: TransitionLaunchReason;
  readonly prior_owner_version: number;
  readonly resulting_owner_version: number;
  readonly effect_descriptor: TransitionEffectDescriptor;
  readonly effect_workflow_id: string;
  readonly actor: string;
  readonly created_at: string;
}

/** Adapter-owned event name, validated by the application registry. */
export type RunTransitionOperation = string;

export interface WorkflowRun {
  readonly id: WorkflowRunId;
  readonly workflow_definition_id: WorkflowDefinitionId;
  readonly workflow_definition_version: number;
  readonly bundle_pin: WorkflowRunBundlePin;
  readonly context: JsonValue;
  readonly status: CoreStatus;
  readonly outcome: StageOutcome | null;
  readonly record_version: RunRecordVersion;
  readonly created_at: string;
  readonly ended_at: string | null;
}

/* ------------------------------------------------------------------ *
 * Run initialization and the decision loop
 * ------------------------------------------------------------------ */

/**
 * A stage instance the run opens with. v15 creates a `stage_instance` row for
 * every definition stage up front — `derive` needs the whole graph, including
 * the dependency edges, to decide anything at all, and a stage with no row is
 * a stage `derive` cannot see. Run detail's synthesized `"pending"` entries
 * (`selectPendingStageOrder`) remain correct for a run created before its
 * stages were opened.
 */
export interface InitializeStageInstance {
  readonly id: StageInstanceId;
  readonly stage_key: StageKey;
  readonly stage_type: string;
  readonly stage_contract: JsonValue;
  readonly dependency_stage_instance_ids: readonly StageInstanceId[];
}

export interface InitializeRun {
  readonly run_id: WorkflowRunId;
  readonly stages: readonly InitializeStageInstance[];
  readonly initialized_at: string;
}

export type InitializeRunResult =
  | { readonly kind: "initialized" | "already_initialized"; readonly run_id: WorkflowRunId }
  | { readonly kind: "run_not_found"; readonly detail: string };

/**
 * What one `decide_run` transaction settled.
 *
 * `transitions` is what the run machine dispatches: every committed transition
 * carries the effect it must act on and the durable workflow id that effect is
 * addressed by, so a replayed dispatch is always the same call.
 */
export interface RunDecision {
  readonly run_id: WorkflowRunId;
  readonly status: CoreStatus;
  readonly record_version: RunRecordVersion;
  readonly outcome: StageOutcome | null;
  readonly transitions: readonly CommittedRunTransition[];
}

export interface CommittedRunTransition {
  readonly transition_id: RunTransitionId;
  readonly owner: TransitionOwner;
  readonly effect: TransitionEffectDescriptor;
  readonly effect_workflow_id: string;
  readonly resulting_owner_version: number;
}

export interface RunRecordRepositoryError {
  readonly operation: "decide_run";
  readonly run_id: WorkflowRunId;
  readonly kind: "run_not_found" | "contradiction" | "version_conflict" | "invalid_effect";
  readonly detail: string;
}

/* ------------------------------------------------------------------ *
 * Cohorts
 * ------------------------------------------------------------------ */

/**
 * A cohort a started stage fans out over, with the adapter state it opens with.
 *
 * It declares no output slots. v15 has no per-cohort slot table and does not
 * need one: the stage's `stage_contract` is pinned when the stage opens, and
 * every output's `artifact_type`, `release` and `attention` is read from there
 * at publication — one source, rather than a copy per cohort that a later
 * definition version could disagree with.
 */
export interface OpenCohort {
  readonly id: CohortId;
  readonly cohort_key: string;
  readonly stage_data: JsonValue;
}

/** One declared output slot, read back off the stage's pinned contract. */
export interface DeclaredOutputSlot {
  readonly output_name: string;
  readonly artifact_type: ArtifactTypeId;
  readonly release: OutputReleaseContract;
  readonly attention: OutputAttention;
}

export interface OpenStageCohorts {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly cohorts: readonly OpenCohort[];
  readonly opened_at: string;
}

export type OpenStageCohortsResult =
  | { readonly kind: "opened" | "already_open"; readonly cohort_ids: readonly CohortId[] }
  | { readonly kind: "stage_not_found"; readonly detail: string };

/**
 * An adapter's decision about one cohort, committed under the cohort's own
 * durable version. The projected status is the adapter's; the effect name is
 * validated by the application registry before it is written.
 */
export interface RecordCohortEvent {
  readonly run_id: WorkflowRunId;
  readonly cohort_id: CohortId;
  readonly expected_version: number;
  readonly change: { readonly status: CoreStatus; readonly blocked_reason: BlockedReason | null; readonly next_actor: NextActor | null; readonly outcome: JsonValue | null };
  readonly stage_data: JsonValue;
  readonly reopen_output_names: readonly string[];
  readonly effect: TransitionEffectDescriptor;
  readonly launch_reason: TransitionLaunchReason;
  readonly actor: string;
  readonly recorded_at: string;
}

export type RecordCohortEventResult =
  | { readonly kind: "recorded"; readonly transition: CommittedRunTransition }
  | { readonly kind: "cohort_not_found" | "version_conflict" | "owner_terminal" | "invalid_effect"; readonly detail: string };

/**
 * A gate this cohort has had decided, and what the decision did to the slot it
 * held. The driver needs both: `release` and `revise` are the same closed wait
 * to core, and only the action tells the cohort which way to go next.
 */
export interface DecidedCohortGate {
  readonly wait_id: WaitId;
  readonly output_name: string | null;
  readonly action: string;
  readonly artifact_id: ArtifactId | null;
  readonly accepted: boolean;
  readonly decided_at: string;
}

/**
 * A wait this cohort is parked on, and the revision it holds.
 *
 * The artifact is carried because *publication* is the fact a cohort machine
 * advances on. Acceptance is the gate's answer, not the agent's: a machine that
 * could only see accepted rows entered its review phase after the gate had
 * already decided, so the decision arrived at a phase that treats it as already
 * acted on and the cohort parked with nobody able to move it.
 */
export interface OpenCohortWait {
  readonly wait_id: WaitId;
  readonly kind: "gate" | "handoff" | "external";
  readonly output_name: string | null;
  readonly artifact_id: ArtifactId | null;
  readonly artifact_body?: JsonValue | null;
}

/** The cohort state a machine reads before applying its next event. */
export interface CohortMachineState {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly stage_key: StageKey;
  readonly cohort_id: CohortId;
  readonly cohort_key: string;
  readonly status: CoreStatus;
  /**
   * Carried beside the status because a driver has to know whether the
   * projection it is about to commit is the one already committed — otherwise a
   * cohort parked on its gate would re-commit "blocked on a gate" on every
   * bounded recheck, burning an owner version per tick.
   */
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly durable_version: number;
  readonly stage_data: JsonValue;
  /**
   * How many attempts this cohort has already had. The next launch is
   * `attempt_count + 1`, which is exactly the uniqueness
   * `oakridge.attempt UNIQUE (cohort_id, attempt_number)` enforces — so a
   * replayed launch dispatch lands on the attempt it already created.
   */
  readonly attempt_count: number;
  /**
   * The cohort's newest attempt that has not ended, whoever created it.
   *
   * Carried because a cohort machine is the only thing that starts an attempt's
   * workflow, and two paths create attempts outside it — an operator retry and an
   * adapter event. Its workflow id is derived from the attempt id, so the machine
   * can start this one on every pass: a duplicate start is a no-op, and it also
   * recovers a crash between the launch commit and the start, which neither
   * off-machine caller could.
   */
  readonly latest_unfinished_attempt_id: AttemptId | null;
  readonly accepted_outputs: readonly ArtifactEnvelope[];
  /** Every open wait this cohort is parked on, oldest first. */
  readonly open_waits: readonly OpenCohortWait[];
  readonly decided_gates: readonly DecidedCohortGate[];
}

/* ------------------------------------------------------------------ *
 * Attempts and sessions
 * ------------------------------------------------------------------ */

/**
 * The attempt a cohort's launch transition names. Created idempotently on
 * `(cohort_id, attempt_number)`: the transition that selected it is durable, so
 * a replayed dispatch must find the attempt it already made rather than open a
 * second one.
 */
export interface StartAttempt {
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly cohort_id: CohortId;
  readonly attempt_id: AttemptId;
  readonly attempt_number: number;
  readonly adapter_type: string;
  readonly request: ExecutionRequest;
  readonly launch_transition_id: RunTransitionId;
  readonly session_id: SessionId;
  /** Present only for an operator retry; `null` for a machine-selected launch. */
  readonly idempotency_key: string | null;
  readonly created_at: string;
}

export type StartAttemptResult =
  | { readonly kind: "started" | "already_started"; readonly attempt_id: AttemptId; readonly session_id: SessionId }
  | { readonly kind: "cohort_not_found"; readonly detail: string }
  | { readonly kind: "idempotency_conflict"; readonly detail: string };

/** Everything the attempt workflow needs to drive one adapter execution. */
export interface AttemptExecution {
  readonly attempt_id: AttemptId;
  readonly session_id: SessionId;
  readonly run_id: WorkflowRunId;
  readonly stage_instance_id: StageInstanceId;
  readonly stage_key: StageKey;
  readonly cohort_id: CohortId;
  readonly cohort_key: string;
  readonly attempt_number: number;
  readonly status: CoreStatus;
  readonly adapter_type: string;
  readonly request: ExecutionRequest;
  readonly adapter_reference: ExternalExecutionReference | null;
  readonly kbbl_session_id: KbblSessionId | null;
}

export interface PriorSessionToFence {
  readonly session_id: SessionId;
  readonly attempt_id: AttemptId;
  readonly adapter_reference: ExternalExecutionReference;
}

export interface BindSession {
  readonly session_id: SessionId;
  readonly adapter_reference: ExternalExecutionReference;
  readonly kbbl_session_id: KbblSessionId | null;
  readonly bound_at: string;
}

export type BindSessionResult = { readonly kind: "bound" } | { readonly kind: "attempt_ended"; readonly status: CoreStatus };
export type SessionStatusWrite = { readonly kind: "written" } | { readonly kind: "already_ended"; readonly status: CoreStatus };

export interface CommitCohortLaunch {
  readonly event: RecordCohortEvent;
  readonly attempt: StartAttempt;
}

export type CohortLaunchCommitted =
  | { readonly kind: "created"; readonly attempt_id: AttemptId; readonly durable_version: number; readonly transition: CommittedRunTransition }
  | { readonly kind: "already_created"; readonly attempt_id: AttemptId; readonly durable_version: number };

export type CohortLaunchCommitError =
  | { readonly kind: "cohort_not_found" | "version_conflict" | "owner_terminal" | "invalid_effect" | "idempotency_conflict"; readonly detail: string };

export type ExecutorHealthObservation =
  | { readonly kind: "running"; readonly observed_at: string }
  | { readonly kind: "unresponsive"; readonly detail: string; readonly observed_at: string }
  | { readonly kind: "ended_succeeded"; readonly metadata: JsonValue; readonly observed_at: string }
  | { readonly kind: "ended_failed"; readonly code: string; readonly detail: string; readonly observed_at: string }
  | { readonly kind: "ended_cancelled"; readonly detail: string | null; readonly observed_at: string };

export const executorHealthFromTerminal = (observation: ExecutorTerminalObservation, observed_at: string): ExecutorHealthObservation => {
  if (observation.kind === "succeeded") return { kind: "ended_succeeded", metadata: observation.metadata, observed_at };
  if (observation.kind === "failed") return { kind: "ended_failed", code: observation.code, detail: observation.detail, observed_at };
  return { kind: "ended_cancelled", detail: observation.detail, observed_at };
};

/**
 * A session's own lifecycle, written from what the adapter reported. The
 * attempt follows its session: `oakridge.attempt` and `oakridge.session` share
 * a status vocabulary and there is exactly one session per attempt, so this is
 * one observation and not two.
 */
export interface ObserveSession {
  readonly session_id: SessionId;
  readonly health: ExecutorHealthObservation;
  readonly observed_at: string;
}

/** Which cohort an operator retry addresses — both forms name exactly one row. */
export type RetryCohortTarget =
  | { readonly kind: "cohort"; readonly cohort_id: CohortId }
  | { readonly kind: "stage_cohort"; readonly stage_instance_id: StageInstanceId; readonly cohort_key: string };

export interface RetryCohort {
  readonly target: RetryCohortTarget;
  readonly idempotency_key: string;
  readonly actor: string;
}

export type RetryCohortResult =
  | {
      readonly kind: "created" | "already_created";
      readonly run_id: WorkflowRunId;
      readonly cohort_id: CohortId;
      readonly attempt_id: AttemptId;
      readonly attempt_number: number;
      readonly durable_version: number;
    }
  | { readonly kind: "cohort_not_found"; readonly detail: string }
  | { readonly kind: "not_active"; readonly detail: string }
  | { readonly kind: "work_in_progress"; readonly detail: string }
  | { readonly kind: "actionable_wait"; readonly detail: string }
  | { readonly kind: "idempotency_conflict"; readonly detail: string };

/* ------------------------------------------------------------------ *
 * Artifacts and waits
 * ------------------------------------------------------------------ */

export interface PublishWorkOrderArtifact {
  readonly artifact_id: ArtifactId;
  /** The attempt whose capability authorizes this publication. */
  readonly attempt_id: AttemptId;
  readonly capability_hash: string;
  readonly output_name: string;
  readonly collection_key?: OutputCollectionKey | null;
  readonly body: JsonValue;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly published_at: string;
}

export type PublishWorkOrderArtifactResult =
  | { readonly kind: "published"; readonly artifact_id: ArtifactId; readonly run_id: WorkflowRunId; readonly cohort_id: CohortId; readonly record_version: RunRecordVersion }
  /** A gated or handoff release policy: the artifact is recorded and its slot parked pending the opened wait's decision. */
  | { readonly kind: "pending"; readonly artifact_id: ArtifactId; readonly wait_id: WaitId; readonly run_id: WorkflowRunId; readonly cohort_id: CohortId; readonly record_version: RunRecordVersion }
  | { readonly kind: "already_applied"; readonly artifact_id: ArtifactId; readonly run_id: WorkflowRunId; readonly cohort_id: CohortId; readonly record_version: RunRecordVersion }
  | { readonly kind: "work_not_found" | "invalid_capability" | "work_abandoned" | "work_not_active" | "slot_not_found"; readonly detail: string }
  | { readonly kind: "slot_already_released"; readonly artifact_id: ArtifactId; readonly detail: string }
  /** A different, non-replay publish arrived while the slot is already parked pending an earlier one's wait. */
  | { readonly kind: "slot_pending"; readonly wait_id: WaitId; readonly detail: string }
  | { readonly kind: "idempotency_conflict"; readonly artifact_id: ArtifactId; readonly detail: string };

export interface DecideGateWait {
  readonly wait_id: WaitId;
  readonly action: string;
  readonly actor: string;
  readonly detail: string | null;
  readonly decided_at: string;
}

export type CloseRunOutputWaitResult =
  | { readonly kind: "released"; readonly artifact_id: ArtifactId; readonly run_id: WorkflowRunId; readonly cohort_id: CohortId | null; readonly record_version: RunRecordVersion }
  | { readonly kind: "invalidated"; readonly run_id: WorkflowRunId; readonly cohort_id: CohortId | null; readonly record_version: RunRecordVersion }
  | { readonly kind: "already_applied"; readonly run_id: WorkflowRunId; readonly cohort_id: CohortId | null; readonly record_version: RunRecordVersion }
  | { readonly kind: "wait_not_found"; readonly detail: string }
  | { readonly kind: "wait_conflict"; readonly detail: string };

/**
 * What a decided gate did to one artifact revision.
 *
 * This replaces v14's `gate_decision_audit` table, whose only production
 * reader was artifact detail's per-revision draft/approved/rejected label.
 * v15 already writes the decision to `wait_gate.outcome` and the transition
 * ledger, with `wait_gate_artifact_revision` linking the wait to the revision
 * it decided, so the fact has a home and the table had nothing left to add.
 */
export interface GateDecisionRecord {
  readonly wait_id: WaitId;
  readonly artifact_revision_id: ArtifactId;
  readonly gate_step: string | null;
  readonly action: string;
  readonly actor: string;
  readonly detail: string | null;
  readonly decided_at: string;
}

/* ------------------------------------------------------------------ *
 * Run lifecycle
 * ------------------------------------------------------------------ */

export interface CancelRunRecord {
  readonly run_id: WorkflowRunId;
  readonly actor: string;
  readonly reason: string | null;
  readonly cancelled_at: string;
}

/** A live session cancellation has to fence, with the handle to fence it by. */
export interface CancelledRunSession {
  readonly session_id: SessionId;
  readonly attempt_id: AttemptId;
  readonly executor_type: string;
  readonly external_reference: ExternalExecutionReference;
}

export type CancelRunRecordResult =
  | { readonly kind: "cancelled"; readonly run_id: WorkflowRunId; readonly record_version: RunRecordVersion; readonly sessions_to_fence: readonly CancelledRunSession[] }
  /**
   * The run was already terminal, and its owners have been swept again.
   *
   * Carries the sessions to fence for the same reason `cancelled` does: this is
   * the result a *re-entry* returns, and re-entry exists because a crash between
   * the run's transition and its owners' leaves both the owners and the external
   * sessions half-finished. A variant with nothing to fence would make the retry
   * that finishes the owners silently skip the sessions.
   */
  | { readonly kind: "already_terminal"; readonly run_id: WorkflowRunId; readonly status: Exclude<CoreStatus, "pending" | "active" | "blocked">; readonly sessions_to_fence: readonly CancelledRunSession[] }
  | { readonly kind: "run_not_found"; readonly detail: string };
