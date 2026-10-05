import type { Trigger } from "../core-client/generated-contracts";
import type { SqlExecutor, TransactionalSqlExecutor } from "../storage/sql-executor";
import type { ExternalHandle, StableInvocation } from "./provider";

export type EffectStatus = "pending" | "in_flight" | "uncertain" | "acknowledged" | "rejected" | "revoked" | "cleanup_pending" | "cleanup_confirmed";
export interface EffectPayload {
  readonly invocation: StableInvocation;
  readonly action: "start" | "stop" | "observe";
  readonly handle: ExternalHandle | null;
  readonly lease?: { readonly owner: string; readonly expires_at: string; readonly fence: number };
  readonly last_detail?: string;
  readonly evidence?: Trigger;
  readonly evidence_delivered?: boolean;
  readonly has_uncertain_start?: boolean;
}
export interface EffectIntent {
  readonly id: string;
  readonly scope_id: string;
  readonly execution_id: string | null;
  readonly effect_key: string;
  readonly payload: EffectPayload;
  readonly status: EffectStatus;
  readonly version: number;
}
interface EffectRow extends Omit<EffectIntent, "version"> { readonly version: string | number }
export interface ClaimedIntent extends EffectIntent { readonly fence: number; readonly owner: string }

/** Claiming is transactional; a dead dispatcher only holds an intent until expiry. */
export async function claimIntents(db: TransactionalSqlExecutor, owner: string, limit: number, lease_ms: number): Promise<readonly ClaimedIntent[]> {
  if (!owner || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(lease_ms) || lease_ms < 1) throw new Error("invalid lease parameters");
  return db.transaction(async (tx) => {
    const clocks = await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now", []);
    const now = clocks[0]?.now ?? new Date();
    const rows = await tx.query<EffectRow>(`SELECT e.* FROM authority.effect_intent e WHERE e.id IN (
      SELECT DISTINCT ON (scope_id) id FROM authority.effect_intent
      WHERE (status IN ('pending','uncertain','cleanup_pending') AND payload ? 'action')
         OR (status='in_flight' AND (payload->'lease'->>'expires_at')::timestamptz <= now())
      ORDER BY scope_id,CASE payload->>'action' WHEN 'stop' THEN 0 WHEN 'start' THEN 1 ELSE 2 END,id)
      ORDER BY CASE e.payload->>'action' WHEN 'stop' THEN 0 WHEN 'start' THEN 1 ELSE 2 END,e.id LIMIT $1 FOR UPDATE OF e SKIP LOCKED`, [limit]);
    const claimed: ClaimedIntent[] = [];
    for (const row of rows) {
      const fence = Number(row.version) + 1;
      const lease = { owner, expires_at: new Date(now.getTime() + lease_ms).toISOString(), fence };
      const payload: EffectPayload = { ...row.payload, lease,
        ...(row.payload.action === "start" && (row.status === "uncertain" || row.status === "in_flight") ? { has_uncertain_start: true } : {}) };
      await tx.query("UPDATE authority.effect_intent SET status='in_flight',payload=$1,version=version+1 WHERE id=$2", [JSON.stringify(payload), row.id]);
      claimed.push({ ...row, payload, status: "in_flight", version: fence, fence, owner });
    }
    return claimed;
  });
}

/** A stale worker cannot acknowledge work after a newer worker has reclaimed it. */
export async function finishClaim(db: SqlExecutor, claim: ClaimedIntent, status: EffectStatus, payload: EffectPayload): Promise<boolean> {
  const rows = await db.query<{ id: string }>(`UPDATE authority.effect_intent SET status=$1,payload=$2,version=version+1
    WHERE id=$3 AND version=$4 AND status='in_flight' AND payload->'lease'->>'owner'=$5
      AND (payload->'lease'->>'expires_at')::timestamptz > clock_timestamp()
    RETURNING id`, [status, JSON.stringify({ ...payload, lease: undefined }), claim.id, claim.fence, claim.owner]);
  return rows.length === 1;
}

export async function pendingCleanupCount(db: SqlExecutor, run_id: string): Promise<number> {
  const rows = await db.query<{ count: string | number }>(`SELECT count(*) AS count FROM authority.effect_intent e
    JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1
    AND ((e.payload ? 'schema' AND e.status<>'revoked') OR e.status='cleanup_pending' OR (e.status='in_flight' AND e.payload->>'action'='stop')
      OR (e.payload->>'action'='start' AND e.status IN ('pending','in_flight','uncertain','acknowledged')
        AND NOT EXISTS (SELECT 1 FROM authority.effect_intent proof WHERE proof.scope_id=e.scope_id
          AND proof.payload->'invocation'->>'id'=e.payload->'invocation'->>'id'
          AND proof.payload->>'action' IN ('stop','observe') AND proof.status='cleanup_confirmed')))`, [run_id]);
  return Number(rows[0]?.count ?? 0);
}
