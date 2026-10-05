import type { SqlExecutor } from "../storage/sql-executor";
export type ScopeId = string & { readonly __scope_id: unique symbol };
export interface ScopeVersion { readonly scope_id: ScopeId; readonly version: number }
export interface VersionConflict { readonly kind: "version_conflict"; readonly scope_id: ScopeId; readonly expected: number; readonly actual: number }
export async function latestScopeVersion(sql: SqlExecutor, scope_id: ScopeId): Promise<number> {
  const rows = await sql.query<{ readonly version: string }>(
    "SELECT COALESCE(MAX(version),0)::text AS version FROM oakridge_replacement.transition WHERE scope_id=$1", [scope_id]);
  return Number(rows[0]?.version ?? "0");
}
export function versionConflict(scope_id: ScopeId, expected: number, actual: number): VersionConflict {
  return { kind: "version_conflict", scope_id, expected, actual };
}
