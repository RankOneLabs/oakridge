export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
export type ProjectId = Brand<string, "ProjectId">;
/** Authority row identities; storage/schema-records.ts applies them to the generated rows. */
export type RunId = Brand<string, "RunId">;
export type RevisionId = Brand<string, "RevisionId">;
export type UnitId = Brand<string, "UnitId">;
/** A core action key: one per RunWorker action, shared by every attempt of a periodic worker. */
export type ActionId = Brand<string, "ActionId">;
export type EventId = Brand<string, "EventId">;
export type DecisionId = Brand<string, "DecisionId">;
export type IntentId = Brand<string, "IntentId">;
export type EffectIntentId = IntentId;
export type IngressId = Brand<string, "IngressId">;
export type DefinitionBundleId = Brand<string, "DefinitionBundleId">;
export type OperatorEventId = Brand<string, "OperatorEventId">;
export type CollaborationThreadId = Brand<string, "CollaborationThreadId">;
export type CollaborationMessageId = Brand<string, "CollaborationMessageId">;
export type ReviewItemId = Brand<string, "ReviewItemId">;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type Result<Value, ErrorValue> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: ErrorValue };

export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });
export const err = <ErrorValue>(error: ErrorValue): Result<never, ErrorValue> => ({ ok: false, error });

/** A failure traced to the operation and entity it occurred on. */
export interface TracedError { readonly operation: string; readonly entity_id: string; readonly detail: string }
export type Traced<Value> = Result<Value, TracedError>;
export const traced = (operation: string, entity_id: string, detail: string): Result<never, TracedError> =>
  ({ ok: false, error: { operation, entity_id, detail } });
