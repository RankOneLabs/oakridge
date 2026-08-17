export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a path segment into a uuid-shaped branded id, or nothing.
 *
 * These ids are stored in `uuid` columns, so a malformed one is not a lookup
 * that finds nothing — Postgres rejects the value while casting it, and the
 * route answers 500 for what is simply an id that cannot exist. The brand is
 * the caller's to name, exactly as the bare `as` casts this replaces did, but
 * now the value has been checked before it carries the name.
 *
 * `UnitId` and `ExecutionId` are deliberately not covered: both are text
 * columns, so any string is a legitimate lookup that finds nothing.
 */
export const parseUuidId = <Id extends string>(raw: string | undefined): Id | null =>
  raw !== undefined && UUID_PATTERN.test(raw) ? raw as Id : null;

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
