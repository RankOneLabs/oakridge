import type { ArtifactId, ExecutionAttemptId, ExecutionId, JsonValue, StageInstanceId, UnitId } from "./primitives";
import type { ArtifactTypeId } from "./workflow";

export interface ArtifactEnvelope {
  readonly artifact_id: ArtifactId;
  readonly artifact_type: ArtifactTypeId;
  readonly output_name: string;
  readonly unit_id: UnitId;
  readonly body: JsonValue;
  readonly producer_execution_id?: ExecutionId;
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
  readonly expected_artifacts?: readonly ExpectedArtifactContract[];
  readonly workspace_source?: { readonly execution_id: ExecutionId; readonly external_reference: ExternalExecutionReference };
}

export type ExternalExecutionReference =
  | { readonly kind: "kbbl_session"; readonly session_id: string }
  | { readonly kind: "headless_run"; readonly run_ref: string }
  | { readonly kind: "none" };

export type ExecutorTerminalObservation =
  | { readonly kind: "succeeded"; readonly metadata: JsonValue }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string }
  | { readonly kind: "cancelled"; readonly detail: string | null };

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
