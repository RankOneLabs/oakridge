import type { ArtifactId, ExecutionAttemptId, ExecutionId, JsonValue, StageInstanceId, UnitId } from "./primitives";
import type { ArtifactTypeId } from "./workflow";

export interface ArtifactEnvelope {
  readonly artifact_id: ArtifactId;
  readonly artifact_type: ArtifactTypeId;
  readonly output_name: string;
  readonly unit_id: UnitId;
  readonly body: JsonValue;
  readonly producer_execution_id?: ExecutionId;
  /**
   * The revision chain this artifact belongs to. A later revision of the same
   * output arrives as a new `artifact_id` under the same chain, which is how a
   * consumer recognises a replacement for something it already holds rather
   * than a second artifact in a slot that has one.
   */
  readonly chain_id?: ArtifactId;
}

export interface OutputContract { readonly name: string; readonly artifact_type: ArtifactTypeId; readonly required: boolean }
export interface ExpectedArtifactContract { readonly unit_id: UnitId; readonly output_name: string; readonly artifact_type: ArtifactTypeId }

export interface ExecutionRequest {
  readonly execution_id: ExecutionId;
  readonly stage_instance_id: StageInstanceId;
  readonly unit_id: UnitId;
  readonly executor_type: string;
  readonly resolved_config: JsonValue;
  readonly inputs: readonly ArtifactEnvelope[];
  readonly declared_outputs: readonly OutputContract[];
  /**
   * Every artifact this execution must release before its unit is satisfied.
   * Required: contract evaluation keys on `unit:output`, and an
   * artifact_collection emits many artifacts under one output name, so the
   * declared outputs alone cannot say what is outstanding.
   */
  readonly expected_artifacts: readonly ExpectedArtifactContract[];
  readonly workspace_source?: { readonly execution_id: ExecutionId; readonly external_reference: ExternalExecutionReference };
}

export type ExternalExecutionReference =
  | { readonly kind: "kbbl_session"; readonly session_id: string; readonly worktree_base_sha?: string }
  | { readonly kind: "headless_run"; readonly run_ref: string }
  /**
   * A deterministic executor's finished work.
   *
   * Such an executor has no external process to attach to, poll or fence: by
   * the time it returns, the work is done. What every later call still needs
   * from it is therefore not a handle but the outcome — and the reference is
   * the one value the execution workflow checkpoints and hands back to each of
   * them. Carrying it here is what keeps the adapter stateless: a backend
   * restart, a step retry and a rerun all replay through the same durable
   * answer instead of asking an empty process what it remembers.
   */
  | { readonly kind: "completed"; readonly observation: ExecutorTerminalObservation }
  | { readonly kind: "none" };

export type ExecutorTerminalObservation =
  | { readonly kind: "succeeded"; readonly metadata: JsonValue }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string }
  | { readonly kind: "cancelled"; readonly detail: string | null };

/**
 * Whether an observation establishes that the executor has actually ended.
 *
 * `succeeded` and `cancelled` are only ever reported from a session that has
 * ended. `failed` is not: the watchdog reports a session that has gone quiet,
 * and a session whose output is sitting in a gate waiting on a human is quiet,
 * alive, and billing. Anything that acts on "the executor is gone" — closing
 * it, or not bothering to — must not read `failed` that way.
 */
export const isExecutorEnded = (observation: ExecutorTerminalObservation | null): boolean =>
  observation !== null && observation.kind !== "failed";

/**
 * One bounded attempt to observe an execution's terminal state. Adapters wait
 * only as long as their transport safely allows and report `pending` when the
 * executor is still running, so the observer workflow — not a single long-lived
 * HTTP request — owns the unbounded wait. `ExecutorTerminalObservation` stays
 * terminal-only: contract evaluation and projections never see `pending`.
 */
export type ExecutorObservationAttempt =
  | { readonly kind: "pending" }
  | { readonly kind: "terminal"; readonly observation: ExecutorTerminalObservation };

/**
 * `external_reference` is required on every post-start operation: the caller
 * always holds one by then, and an adapter that had to fall back to in-process
 * memory silently did nothing after a backend restart — a fence that no-ops is
 * worse than one that fails, because the executor keeps running unobserved.
 */
export interface ExecutorAdapter {
  readonly executor_type: string;
  start_or_attach(request: ExecutionRequest, attempt_id: ExecutionAttemptId): Promise<ExternalExecutionReference>;
  observe_terminal(execution_id: ExecutionId, external_reference: ExternalExecutionReference): Promise<ExecutorObservationAttempt>;
  deliver_input(execution_id: ExecutionId, delivery_key: string, input: string, external_reference: ExternalExecutionReference): Promise<void>;
  cancel_or_fence(execution_id: ExecutionId, external_reference: ExternalExecutionReference): Promise<void>;
}
