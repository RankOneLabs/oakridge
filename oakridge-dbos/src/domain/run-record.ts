import type { ExecutorTerminalObservation, ExternalExecutionReference } from "./execution";
import type { CoreStatus } from "./records";
import type {
  ArtifactId,
  AttemptId,
  CohortId,
  JsonValue,
  OutputCollectionKey,
  RunRecordVersion,
  RunTransitionId,
  SessionId,
  StageInstanceId,
  WorkflowDefinitionId,
  WorkflowRunId,
} from "./primitives";
import type { StageKey, StageOutcome, WorkflowRunBundlePin } from "./workflow";

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
  readonly event: JsonValue;
  readonly from_state: string | null;
  readonly to_state: string | null;
  readonly effect_descriptor: TransitionEffectDescriptor;
  readonly effect_workflow_id: string;
  readonly effects_started_at: string | null;
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

export interface StageRosterError {
  readonly operation: "fail_stage_roster";
  readonly stage_instance_id: StageInstanceId;
  readonly kind: "stage_not_found" | "version_conflict" | "invalid_effect";
  readonly detail: string;
}

/* ------------------------------------------------------------------ *
 * Cohorts
 * ------------------------------------------------------------------ */

export interface PriorSessionToFence {
  readonly session_id: SessionId;
  readonly attempt_id: AttemptId;
  readonly adapter_reference: ExternalExecutionReference;
}

export type SessionStatusWrite = { readonly kind: "written" } | { readonly kind: "already_ended"; readonly status: CoreStatus };

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

export interface PublishWorkOrderArtifact {
  readonly artifact_id: ArtifactId;
  /** The attempt whose capability authorizes this publication. */
  readonly attempt_id: AttemptId;
  readonly capability_hash: string;
  readonly output_name: string;
  readonly collection_key?: OutputCollectionKey | null;
  readonly body: JsonValue;
  readonly enrichment?: JsonValue | null;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly published_at: string;
}

export type PublishWorkOrderArtifactResult =
  | { readonly kind: "published"; readonly artifact_id: ArtifactId; readonly run_id: WorkflowRunId; readonly cohort_id: CohortId; readonly record_version: RunRecordVersion }
  | { readonly kind: "already_applied"; readonly artifact_id: ArtifactId; readonly run_id: WorkflowRunId; readonly cohort_id: CohortId; readonly record_version: RunRecordVersion }
  | { readonly kind: "work_not_found" | "invalid_capability" | "work_abandoned" | "work_not_active" | "slot_not_found"; readonly detail: string }
  | { readonly kind: "idempotency_conflict"; readonly artifact_id: ArtifactId; readonly detail: string }
  | { readonly kind: "refused"; readonly code: string; readonly detail: string }
  | { readonly kind: "enrichment_unavailable"; readonly detail: string };

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
