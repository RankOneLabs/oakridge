/**
 * What one call of a code operation produced. `succeeded` carries the body
 * the executor publishes as the revision of the worker's artifact; `failed`
 * is a definite failure reported on the attempt; `unavailable` is transient
 * and retried by the executor before anything is reported (part 1 §2.5).
 */
export type OperationOutcome =
  | { readonly kind: "succeeded"; readonly body: unknown }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

export interface OperationCallOptions { readonly signal?: AbortSignal }

type Fields = { readonly [key: string]: unknown };
export const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
export const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
