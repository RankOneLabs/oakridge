import type { WorkerResult } from "../core-client/core-types";
import type { EffectInstruction } from "../domain/effect-instruction";
import type { INPUT_CONTRACTS } from "./provider-catalog";

export interface ProviderCallOptions { readonly signal?: AbortSignal }

export type ProviderResult<Value> =
  | { readonly kind: "acknowledged"; readonly value: Value }
  | { readonly kind: "permanently_rejected"; readonly code: string; readonly detail: string }
  | { readonly kind: "transiently_unavailable"; readonly detail: string }
  | { readonly kind: "uncertain"; readonly detail: string };

/** A live agent session an attempt runs in. */
export type ExternalHandle = { readonly kind: typeof INPUT_CONTRACTS.session; readonly session_id: string };
/** What a session start produced: the session, and the hash of the publication secret its preamble carries. */
export interface StartedSession { readonly handle: ExternalHandle; readonly publication_secret_hash: string }
export type TerminalObservation = { readonly kind: "running" } | { readonly kind: "terminal"; readonly result: WorkerResult };

/** Rendered once per attempt at session start, in a checkpointed step: the attempt's task, delivered as the session's input. */
export interface SessionMaterial { readonly task: string }

/**
 * Carries an agent attempt to its kbbl session (part 1 §7.2). Every call is
 * idempotent by the instruction's session key and action, so a carrier re-run
 * after a crash reaches the same session and the same delivered task.
 */
export interface EffectProvider {
  /** Ensure the attempt's session. Its task is delivered by the first observation, after WorkerStarted is committed. */
  start(instruction: EffectInstruction, options?: ProviderCallOptions): Promise<ProviderResult<StartedSession>>;
  /** Deliver the task (a repeat returns the first delivery's receipt) and report how its turn stands. */
  observe(instruction: EffectInstruction, material: SessionMaterial, handle: ExternalHandle, options?: ProviderCallOptions): Promise<ProviderResult<TerminalObservation>>;
  /** Stop by attempt, including a start whose response was lost; a null handle means none was recorded. */
  stop(instruction: EffectInstruction, handle: ExternalHandle | null, options?: ProviderCallOptions): Promise<ProviderResult<{ readonly stopped: true }>>;
}
