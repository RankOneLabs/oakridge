import type { CheckedValue, DecisionOutcome, ReadVersion } from "../core-client/generated-contracts";
import type { SqlExecutor } from "../storage/sql-executor";
import type { ScopeId } from "./scope-version";
export interface ScopeTransition {
  readonly id: string; readonly scope_id: ScopeId; readonly version: number;
  readonly local_value: CheckedValue; readonly decision: DecisionOutcome;
  readonly read_set: readonly ReadVersion[];
}
export async function loadTransition(sql: SqlExecutor, scope_id: ScopeId): Promise<ScopeTransition | null> {
  const rows = await sql.query<ScopeTransition>(
    "SELECT id,scope_id,version,local_value,decision,read_set FROM oakridge_replacement.transition WHERE scope_id=$1 ORDER BY version DESC LIMIT 1", [scope_id]);
  return rows[0] ?? null;
}
