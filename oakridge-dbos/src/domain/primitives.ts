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

/**
 * One attempt at an execution — the ID of the workflow running it. A rerun
 * forks that workflow under a new ID, so this changes per attempt while staying
 * stable across step retries and recovery of the same attempt. That is exactly
 * the identity an external executor session must be keyed on: the execution id
 * alone is shared by every attempt, so keying on it makes a rerun re-attach to
 * the session that already died.
 */
export type ExecutionAttemptId = Brand<string, "ExecutionAttemptId">;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Narrows parsed request bodies at the IO boundary; lives beside the type it guards. */
export const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value as object).every(isJsonValue);
};

export type Result<Value, ErrorValue> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: ErrorValue };

export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });
export const err = <ErrorValue>(error: ErrorValue): Result<never, ErrorValue> => ({ ok: false, error });
