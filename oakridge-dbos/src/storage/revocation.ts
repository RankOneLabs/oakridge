import { requiresCleanup, type EffectIntent, type EffectPayload } from "../effects/intents";
import type { SqlExecutor } from "./sql-executor";
import { sealEffectPayload, unsealEffectPayload } from "./effect-secret";

interface EffectRow extends Omit<EffectIntent, "version"> { readonly version: string | number }

/** Record the one stop owed by a start, inside the caller's transaction. */
export async function ensureStopIntent(tx: SqlExecutor, start: Pick<EffectIntent, "scope_id" | "execution_id" | "effect_key" | "payload">): Promise<string | null> {
  const payload: EffectPayload = { invocation: start.payload.invocation, action: "stop", handle: start.payload.handle };
  const stops = await tx.query<{ id: string }>(`INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload,status)
    VALUES ($1,$2,$3,$4,$5,'cleanup_pending') ON CONFLICT (scope_id,effect_key) DO UPDATE SET version=authority.effect_intent.version RETURNING id`,
    [crypto.randomUUID(), start.scope_id, start.execution_id, `${start.effect_key}:stop`, JSON.stringify(sealEffectPayload(payload))]);
  return stops[0]?.id ?? null;
}

/**
 * Revoke every start in the given scopes (for one worker, or every worker when
 * `worker` is null) and record a stop intent for each one that may own an
 * external execution. Runs inside the caller's transaction so the revocation
 * and the stop are one write. Repeating a revocation is harmless: an
 * already-revoked start keeps its one stop. Returns the stop intent ids owed.
 */
export async function revokeStarts(tx: SqlExecutor, scope_ids: readonly string[], worker: string | null): Promise<readonly string[]> {
  const starts = await tx.query<EffectRow>(`SELECT i.* FROM authority.effect_intent i JOIN authority.execution e ON e.id=i.execution_id
    WHERE i.scope_id=ANY($1::text[]) AND ($2::text IS NULL OR e.worker_key=$2)
      AND i.payload->>'action'='start' AND i.status IN ('pending','acknowledged','revoked','rejected') FOR UPDATE OF i`, [scope_ids, worker]);
  const stop_ids: string[] = [];
  for (const start of starts) {
    const decoded = { ...start, payload: unsealEffectPayload(start.payload) };
    // A definite rejection stays rejected; it still owes a stop if an earlier attempt was uncertain.
    const status = start.status === "rejected" ? "rejected" : "revoked";
    if (start.status !== status) await tx.query("UPDATE authority.effect_intent SET status='revoked',updated_at=now(),version=version+1 WHERE id=$1", [start.id]);
    if (!requiresCleanup({ status, payload: decoded.payload })) continue;
    const stop_id = await ensureStopIntent(tx, decoded);
    if (stop_id) stop_ids.push(stop_id);
  }
  return stop_ids;
}
