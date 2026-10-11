export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
export type WorkflowRunId = Brand<string, "WorkflowRunId">;
export type StageInstanceId = Brand<string, "StageInstanceId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type ProjectId = Brand<string, "ProjectId">;
export type ExecutionId = Brand<string, "ExecutionId">;
/** Authority row identities; storage/schema-records.ts applies them to the generated rows. */
export type RunId = Brand<string, "RunId">;
export type ScopeId = Brand<string, "ScopeId">;
export type RevisionId = Brand<string, "RevisionId">;
export type PoolId = Brand<string, "PoolId">;
export type UnitId = Brand<string, "UnitId">;
export type ExecutorOperationId = Brand<string, "ExecutorOperationId">;
export type RunTransitionId = Brand<string, "RunTransitionId">;
export type CohortId = Brand<string, "CohortId">;
export type AttemptId = Brand<string, "AttemptId">;
export type SessionId = Brand<string, "SessionId">;
export type OperatorEventId = Brand<string, "OperatorEventId">;
export type CollaborationThreadId = Brand<string, "CollaborationThreadId">;
export type CollaborationMessageId = Brand<string, "CollaborationMessageId">;
export type ReviewItemId = Brand<string, "ReviewItemId">;
export type CollaborationDeliveryId = Brand<string, "CollaborationDeliveryId">;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type Result<Value, ErrorValue> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: ErrorValue };

export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });
export const err = <ErrorValue>(error: ErrorValue): Result<never, ErrorValue> => ({ ok: false, error });
