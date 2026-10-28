export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
export type Result<Value, ErrorValue> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: ErrorValue };
export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });
export const err = <ErrorValue>(error: ErrorValue): Result<never, ErrorValue> => ({ ok: false, error });

/** A JSON value is recursive; envelopes use named payload types for known shapes. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
