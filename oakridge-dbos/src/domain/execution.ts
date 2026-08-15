import type { ArtifactId, ExecutionId, JsonValue, StageInstanceId, UnitId } from "./primitives";
import type { ArtifactTypeId } from "./workflow";

export interface ArtifactEnvelope {
  readonly artifact_id: ArtifactId;
  readonly artifact_type: ArtifactTypeId;
  readonly output_name: string;
  readonly unit_id: UnitId;
  readonly body: JsonValue;
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
}

export type ExternalExecutionReference =
  | { readonly kind: "kbbl_session"; readonly session_id: string }
  | { readonly kind: "headless_run"; readonly run_ref: string }
  | { readonly kind: "none" };

export type ExecutorTerminalObservation =
  | { readonly kind: "succeeded"; readonly metadata: JsonValue }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string }
  | { readonly kind: "cancelled"; readonly detail: string | null };

export interface ExecutorAdapter {
  readonly executor_type: string;
  start_or_attach(request: ExecutionRequest): Promise<ExternalExecutionReference>;
  observe_terminal(execution_id: ExecutionId, external_reference?: ExternalExecutionReference): Promise<ExecutorTerminalObservation>;
  request_revision(execution_id: ExecutionId, delivery_key: string, feedback: string, external_reference?: ExternalExecutionReference): Promise<void>;
  cancel_or_fence(execution_id: ExecutionId, external_reference?: ExternalExecutionReference): Promise<void>;
}
