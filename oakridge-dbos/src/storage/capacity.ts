import type { CapacityPoolRecord, PoolId, ScopeId } from "./schema-records";
import type { Result } from "./commit";
import type { SqlExecutor } from "./sql-executor";

export interface CapacityChange { readonly pool_id: PoolId; readonly scope_id: ScopeId; readonly kind: "acquire" | "release" }
export async function applyCapacityChanges(tx: SqlExecutor, changes: readonly CapacityChange[]): Promise<Result<void>> {
  for (const change of changes) {
    const pools = await tx.query<CapacityPoolRecord>("SELECT * FROM authority.capacity_pool WHERE id=$1 FOR UPDATE", [change.pool_id]);
    const pool = pools[0];
    if (!pool) return { ok: false, error: { operation: "apply_capacity", entity_id: change.pool_id, detail: "capacity pool missing" } };
    const active = await tx.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.capacity_reservation WHERE pool_id=$1 AND is_active", [pool.id]);
    const existing = await tx.query<{ is_active: boolean }>("SELECT is_active FROM authority.capacity_reservation WHERE pool_id=$1 AND scope_id=$2", [change.pool_id, change.scope_id]);
    if (change.kind === "acquire" && !existing[0]?.is_active && Number(active[0]?.count ?? 0) >= pool.capacity) return { ok: false, error: { operation: "apply_capacity", entity_id: pool.id, detail: "capacity limit reached" } };
    if (change.kind === "acquire") await tx.query("INSERT INTO authority.capacity_reservation (id,pool_id,scope_id) VALUES ($1,$2,$3) ON CONFLICT (pool_id,scope_id) DO UPDATE SET is_active=true, version=authority.capacity_reservation.version+1", [crypto.randomUUID(), change.pool_id, change.scope_id]);
    else await tx.query("UPDATE authority.capacity_reservation SET is_active=false, version=version+1 WHERE pool_id=$1 AND scope_id=$2 AND is_active", [change.pool_id, change.scope_id]);
    await tx.query("UPDATE authority.capacity_pool SET version=version+1 WHERE id=$1", [change.pool_id]);
  }
  return { ok: true, value: undefined };
}
