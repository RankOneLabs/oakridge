import type { WorkerResult } from "../core-client/core-types";
import type { EffectInstruction } from "../domain/effect-instruction";
import type { INPUT_CONTRACTS } from "./provider-catalog";

/** Kept by the kbbl adapter's request vocabulary. */
export type InvocationId = string & { readonly __invocation_id: unique symbol };
export interface ProviderCallOptions { readonly signal?: AbortSignal }

export type ProviderResult<Value> =
  | { readonly kind: "acknowledged"; readonly value: Value }
  | { readonly kind: "permanently_rejected"; readonly code: string; readonly detail: string }
  | { readonly kind: "transiently_unavailable"; readonly detail: string }
  | { readonly kind: "uncertain"; readonly detail: string };

/** What a start produced: a live agent session, or a finished code operation's result. */
export type ExternalHandle =
  | { readonly kind: typeof INPUT_CONTRACTS.session; readonly session_id: string }
  | { readonly kind: "completed"; readonly result: WorkerResult };
export type TerminalObservation = { readonly kind: "running" } | { readonly kind: "terminal"; readonly result: WorkerResult };

/**
 * Carries one effect instruction to the outside world. Every call is
 * idempotent by the instruction's attempt, so a carrier re-run after a crash
 * reaches the same execution.
 */
export interface EffectProvider {
  start(instruction: EffectInstruction, options?: ProviderCallOptions): Promise<ProviderResult<ExternalHandle>>;
  observe(instruction: EffectInstruction, handle: ExternalHandle, options?: ProviderCallOptions): Promise<ProviderResult<TerminalObservation>>;
  /** Stop by attempt, including a start whose response was lost; a null handle means none was recorded. */
  stop(instruction: EffectInstruction, handle: ExternalHandle | null, options?: ProviderCallOptions): Promise<ProviderResult<{ readonly stopped: true }>>;
}
