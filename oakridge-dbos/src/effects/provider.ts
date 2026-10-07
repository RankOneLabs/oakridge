import type { CheckedValue, Invocation, Trigger } from "../core-client/generated-contracts";
import { INPUT_CONTRACTS } from "./provider-catalog";

/** The selection in the decision ledger is the source of the provider request. */
export type InvocationId = string & { readonly __invocation_id: unique symbol };
export type EffectId = string & { readonly __effect_id: unique symbol };

export interface StableInvocation {
  readonly id: InvocationId;
  readonly execution_id: string;
  readonly selection: Invocation;
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
  | { readonly kind: "permanently_rejected"; readonly code: string; readonly detail: string; readonly evidence?: Trigger }
  | { readonly kind: "transiently_unavailable"; readonly detail: string }
  | { readonly kind: "uncertain"; readonly detail: string };

export type ExternalHandle =
  | { readonly kind: "completed"; readonly result: CheckedValue; readonly evidence?: Trigger }
  | { readonly kind: typeof INPUT_CONTRACTS.session; readonly session_id: string }
  | { readonly kind: "repository"; readonly path: string }
  | { readonly kind: "pull_request"; readonly owner: string; readonly name: string; readonly number: number };

export type TerminalObservation =
  | { readonly kind: "running" }
  | { readonly kind: "terminal"; readonly result: CheckedValue; readonly evidence?: Trigger };

export interface EffectProvider {
  /** A repeated id must resolve to the same external action. */
  start(invocation: StableInvocation, options?: ProviderCallOptions): Promise<ProviderResult<ExternalHandle>>;
  /** Stop by invocation id, including a start whose response was lost. */
  stop(invocation: StableInvocation, handle: ExternalHandle | null, options?: ProviderCallOptions): Promise<ProviderResult<{ readonly stopped: true }>>;
  observe(invocation: StableInvocation, handle: ExternalHandle | null, options?: ProviderCallOptions): Promise<ProviderResult<TerminalObservation>>;
}

export function selectedInvocation(id: InvocationId, execution_id: string, selection: Invocation): StableInvocation {
  return { id, execution_id, selection, bytes: JSON.stringify({ invocation_id: id, execution_id, selection }) };
}

export function repeatInvocation(invocation: StableInvocation): StableInvocation {
  return invocation;
}

export function deliberateRetry(previous: StableInvocation, next_id: InvocationId): StableInvocation {
  if (next_id === previous.id) throw new Error("a deliberate retry requires a new invocation identity");
  return selectedInvocation(next_id, previous.execution_id, previous.selection);
}
