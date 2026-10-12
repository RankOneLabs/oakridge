import type { Trigger } from "../core-client/core-types";
import type { SqlExecutor } from "../storage/sql-executor";
import type { EffectIntentRecord, EffectStatus } from "../storage/schema-records";
import type { ExternalHandle, StableInvocation } from "./provider";
import { unsealEffectPayload } from "../storage/effect-secret";

/**
 * Durable effect intent states (the authority.effect_status enum). The row is the authority on what the runtime
 * owes the outside world; DBOS owns the execution that moves a row between
 * these states, including retries, sleeps and recovery after a crash.
 *
 * - `pending`: committed and not yet acknowledged by the provider.
 * - `acknowledged`: the provider returned an external handle; observation continues.
 * - `stop_requested`: authority has requested cleanup of the action.
 * - `stopped`: cleanup of the action was acknowledged.
 * - `failed`: the action ended without an external execution to clean up.
 */
export type { EffectStatus };
export type EffectFailure =
  | { readonly kind: "provider_rejection"; readonly code: string; readonly detail: string }
  | { readonly kind: "attempt_budget_exhausted"; readonly detail: string }
  | { readonly kind: "observation_rejection"; readonly detail: string };
export interface EffectPayload {
  readonly invocation: StableInvocation;
  readonly action: "start" | "stop";
  readonly handle: ExternalHandle | null;
  /** Reserved provider start attempts, retained across workflow recovery. */
  readonly start_attempts?: number;
  /** The reserved attempt has no durably recorded provider outcome yet. */
  readonly start_in_flight?: boolean;
  /** Consecutive unavailable observations, persisted across workflow recovery. */
  readonly observe_unavailable_attempts?: number;
  readonly last_detail?: string;
  readonly failure?: EffectFailure;
  readonly evidence?: Trigger;
  readonly evidence_delivered?: boolean;
  /** A provider start call was issued at least once; an external execution may exist. */
  readonly has_dispatched?: boolean;
  /** A start attempt ended without a definite answer; an external execution may exist. */
  readonly has_uncertain_start?: boolean;
}
/** An effect_intent row with its payload unsealed. */
export type EffectIntent = Omit<EffectIntentRecord, "run_id" | "payload"> & { readonly payload: EffectPayload };
interface EffectRow extends Omit<EffectIntent, "version"> { readonly version: string | number }

export async function readIntent(db: SqlExecutor, intent_id: string): Promise<EffectIntent | null> {
  const rows = await db.query<EffectRow>("SELECT * FROM authority.effect_intent WHERE id=$1", [intent_id]);
  const row = rows[0];
  return row ? { ...row, payload: unsealEffectPayload(row.payload), version: Number(row.version) } : null;
}

/** The action row itself is the cleanup proof; no separate stop row exists in v2. */
export function requiresCleanup(intent: Pick<EffectIntent, "status" | "payload">): boolean {
  return intent.status !== "stopped" && intent.status !== "failed";
}

/** Every nonterminal action row blocks deletion, even before dispatch. */
export async function pendingCleanupCount(db: SqlExecutor, run_id: string): Promise<number> {
  const rows = await db.query<{ count: string | number }>(`SELECT count(*) AS count FROM authority.effect_intent e
    WHERE e.run_id=$1 AND e.status NOT IN ('stopped','failed')`, [run_id]);
  return Number(rows[0]?.count ?? 0);
}

export type DeleteEligibility = { readonly kind: "allowed" } | { readonly kind: "refused"; readonly obligations: number };
/** A stopped or failed action row is the only cleanup proof. */
export async function deletionEligibility(db: SqlExecutor, run_id: string): Promise<DeleteEligibility> {
  const obligations = await pendingCleanupCount(db, run_id);
  return obligations === 0 ? { kind: "allowed" } : { kind: "refused", obligations };
}
