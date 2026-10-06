import { requiresCleanup, type EffectIntent, type EffectPayload } from "../effects/intents";
import type { SqlExecutor } from "./sql-executor";

interface EffectRow extends Omit<EffectIntent, "version"> { readonly version: string | number }

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
      AND i.payload->>'action'='start' AND i.status IN ('pending','acknowledged','revoked') FOR UPDATE OF i`, [scope_ids, worker]);
  const stop_ids: string[] = [];
  for (const start of starts) {
    if (start.status !== "revoked") await tx.query("UPDATE authority.effect_intent SET status='revoked',version=version+1 WHERE id=$1", [start.id]);
    if (!requiresCleanup({ status: "revoked", payload: start.payload })) continue;
    const payload: EffectPayload = { invocation: start.payload.invocation, action: "stop", handle: start.payload.handle };
    const stops = await tx.query<{ id: string }>(`INSERT INTO authority.effect_intent (id,scope_id,execution_id,effect_key,payload,status)
      VALUES ($1,$2,$3,$4,$5,'cleanup_pending') ON CONFLICT (scope_id,effect_key) DO UPDATE SET version=authority.effect_intent.version RETURNING id`,
      [crypto.randomUUID(), start.scope_id, start.execution_id, `${start.effect_key}:stop`, JSON.stringify(payload)]);
    if (stops[0]) stop_ids.push(stops[0].id);
  }
  return stop_ids;
}
