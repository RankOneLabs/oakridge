// Pure attempt-identity transforms over `GET /runs/:id/sessions`.
//
// The route returns the run's whole session history — one entry per work order
// that has a session, oldest first, with no state filter. Turning that into a
// sidebar means answering two questions the raw list does not: which attempts
// belong to the same unit, and which one of them is the unit's *current*
// attempt. Both are pure functions of the rows, so both live here rather than
// in a component render body.
//
// That oldest-first order is a contract, not a convenience: it is how these
// transforms know which attempt is newest, and a caller that re-sorts the list
// before passing it here will get the wrong current attempt.

import type { RunSessionAttempt } from "../types";

/**
 * A unit's identity within a run. `unit_id` alone is not unique — a fan-out
 * stage mints unit ids per stage instance, so two stages can each have a unit
 * `"0"` — so the key is the pair.
 */
export type RunUnitKey = string & { readonly __brand: "RunUnitKey" };

export const runUnitKeyOf = (attempt: RunSessionAttempt): RunUnitKey =>
  `${attempt.stage_instance_id}:${attempt.unit_id}` as RunUnitKey;

export interface RunSessionRow {
  readonly attempt: RunSessionAttempt;
  readonly unit_key: RunUnitKey;
  /**
   * Whether this is the attempt that currently represents its unit — the one a
   * sidebar should open by default and mark live.
   */
  readonly is_current: boolean;
  /** 1-based position among the unit's own attempts, oldest first, for an "attempt 2 of 3" label. */
  readonly attempt_number: number;
  /** How many attempts the unit has in total. */
  readonly attempt_count: number;
}

/**
 * The unit's current attempt is its newest *non-abandoned* one.
 *
 * An abandoned work order is one the run gave up on — superseded by a retry,
 * or cancelled — so it is never what the unit currently is, even when it is
 * the most recently created row. When every attempt was abandoned there is no
 * better answer than the newest, so that wins rather than the unit showing no
 * current attempt at all.
 *
 * "Newest" means the last row, not the largest `created_at`. The route already
 * ordered the list `ORDER BY work.created_at, work.id` in Postgres, comparing
 * real timestamps; what reaches us is `timestamptz::text`, whose rendered UTC
 * offset follows a session timezone nothing in the backend pins. Comparing
 * those strings would read a DST fold backwards — `01:15:00-05` sorts before
 * `01:30:00-04` but happens 45 minutes after it — so this trusts the ordering
 * the database already did rather than redoing it on the rendering. That also
 * makes two attempts created in the same transaction resolve deterministically,
 * by `work.id`, instead of by whichever a comparison happened to see first.
 */
const selectCurrentAttemptIndex = (attempts: readonly RunSessionAttempt[]): number => {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]?.work_order_state !== "abandoned") return index;
  }
  return attempts.length - 1;
};

/**
 * The run's attempts as sidebar rows, input order preserved (oldest first),
 * with each unit's current attempt marked and each attempt numbered within its
 * unit.
 */
export const selectRunSessionRows = (attempts: readonly RunSessionAttempt[]): readonly RunSessionRow[] => {
  const byUnit = new Map<RunUnitKey, RunSessionAttempt[]>();
  for (const attempt of attempts) {
    const key = runUnitKeyOf(attempt);
    const existing = byUnit.get(key);
    if (existing) existing.push(attempt);
    else byUnit.set(key, [attempt]);
  }

  const currentWorkOrderIds = new Set<string>();
  for (const unitAttempts of byUnit.values()) {
    const current = unitAttempts[selectCurrentAttemptIndex(unitAttempts)];
    if (current) currentWorkOrderIds.add(current.work_order_id);
  }

  return attempts.map((attempt) => {
    const key = runUnitKeyOf(attempt);
    const unitAttempts = byUnit.get(key) ?? [];
    return {
      attempt,
      unit_key: key,
      is_current: currentWorkOrderIds.has(attempt.work_order_id),
      attempt_number: unitAttempts.indexOf(attempt) + 1,
      attempt_count: unitAttempts.length,
    };
  });
};
