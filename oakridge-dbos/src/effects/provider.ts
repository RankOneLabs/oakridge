import type { Action, Event as CoreEvent } from "../core-client/core-types";
import type { RuntimeValue } from "../storage/json-column-types";
import { INPUT_CONTRACTS } from "./provider-catalog";
import type { SessionInvocationSettings } from "../domain/session-settings";

/** The selection in the decision ledger is the source of the provider request. */
export type InvocationId = string & { readonly __invocation_id: unique symbol };
export type EffectId = string & { readonly __effect_id: unique symbol };

/**
 * v1 carried the start budget on the selection's definition. A v2 Action has
 * no such field, so the executor states its own budget per invocation.
 */
export const DEFAULT_MAX_START_ATTEMPTS = 3;
/** v1 read the per-call deadline off the selection's definition; v2 states it here. */
export const DEFAULT_PROVIDER_DEADLINE_MS = 600_000;

export interface StableInvocation {
  readonly id: InvocationId;
  /** Provider start attempts this invocation may reserve before it is rejected. */
  readonly max_start_attempts: number;
  /** Wall-clock budget for one provider call on this invocation. */
  readonly deadline_ms: number;
  readonly execution_id: string;
  readonly selection: Action;
  readonly session_settings: SessionInvocationSettings | null;
  /** Persisted request bytes. Recovery sends these bytes without re-rendering. */
  readonly bytes: string;
  readonly request?: ProviderRequest;
}

/** Versioned transport metadata; bytes contains the exact selected request body. */
export type ProviderRequest =
  | { readonly version: 1; readonly kind: typeof INPUT_CONTRACTS.session; readonly session_key: string }
  | { readonly version: 1; readonly kind: typeof INPUT_CONTRACTS.repository }
  | { readonly version: 1; readonly kind: typeof INPUT_CONTRACTS.pull_request }
  | { readonly version: 1; readonly kind: typeof INPUT_CONTRACTS.stub };
export interface ProviderCallOptions { readonly signal?: AbortSignal }

export type ProviderResult<Value> =
  | { readonly kind: "acknowledged"; readonly value: Value }
  | { readonly kind: "permanently_rejected"; readonly code: string; readonly detail: string; readonly evidence?: CoreEvent }
  | { readonly kind: "transiently_unavailable"; readonly detail: string }
  | { readonly kind: "uncertain"; readonly detail: string };

export type ExternalHandle =
  | { readonly kind: "completed"; readonly result: RuntimeValue; readonly evidence?: CoreEvent }
  | { readonly kind: typeof INPUT_CONTRACTS.session; readonly session_id: string }
  | { readonly kind: "repository"; readonly path: string }
  | { readonly kind: "pull_request"; readonly owner: string; readonly name: string; readonly number: number };

export type TerminalObservation =
  | { readonly kind: "running" }
  | { readonly kind: "terminal"; readonly result: RuntimeValue; readonly evidence?: CoreEvent };

export interface EffectProvider {
  /** A repeated id must resolve to the same external action. */
  start(invocation: StableInvocation, options?: ProviderCallOptions): Promise<ProviderResult<ExternalHandle>>;
  /** Stop by invocation id, including a start whose response was lost. */
  stop(invocation: StableInvocation, handle: ExternalHandle | null, options?: ProviderCallOptions): Promise<ProviderResult<{ readonly stopped: true }>>;
  observe(invocation: StableInvocation, handle: ExternalHandle | null, options?: ProviderCallOptions): Promise<ProviderResult<TerminalObservation>>;
}

export function selectedInvocation(id: InvocationId, execution_id: string, selection: Action, session_settings: SessionInvocationSettings | null): StableInvocation {
  return { id, execution_id, selection, session_settings, max_start_attempts: DEFAULT_MAX_START_ATTEMPTS, deadline_ms: DEFAULT_PROVIDER_DEADLINE_MS,
    bytes: JSON.stringify({ invocation_id: id, execution_id, selection, session_settings }) };
}

export function repeatInvocation(invocation: StableInvocation): StableInvocation {
  return invocation;
}

export function deliberateRetry(previous: StableInvocation, next_id: InvocationId, session_settings: SessionInvocationSettings | null): StableInvocation {
  if (next_id === previous.id) throw new Error("a deliberate retry requires a new invocation identity");
  return selectedInvocation(next_id, previous.execution_id, previous.selection, session_settings);
}
