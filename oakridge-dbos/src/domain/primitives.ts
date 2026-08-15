export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type WorkflowDefinitionId = Brand<string, "WorkflowDefinitionId">;
export type WorkflowRunId = Brand<string, "WorkflowRunId">;
export type StageInstanceId = Brand<string, "StageInstanceId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type ProjectId = Brand<string, "ProjectId">;
export type ExecutionId = Brand<string, "ExecutionId">;
export type RootWorkflowId = Brand<string, "RootWorkflowId">;
export type StageCoordinatorWorkflowId = Brand<string, "StageCoordinatorWorkflowId">;
export type UnitId = Brand<string, "UnitId">;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type Result<Value, ErrorValue> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: ErrorValue };

export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });
export const err = <ErrorValue>(error: ErrorValue): Result<never, ErrorValue> => ({ ok: false, error });
