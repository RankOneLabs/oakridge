import type { ExecutionRecord, ResourceBindingRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

export interface ScopeDiagnostics {
  readonly scope_id: string; readonly scope_version: number;
  readonly executions: readonly ExecutionRecord[]; readonly resources: readonly ResourceBindingRecord[];
  readonly effects: readonly { readonly id: string; readonly effect_key: string; readonly status: string; readonly version: number }[];
}
export async function readScopeDiagnostics(db: TransactionalSqlExecutor, scope_id: string): Promise<ScopeDiagnostics | null> {
  return db.transaction(async (tx) => {
    const owner = (await tx.query<{ version: string | number }>("SELECT version FROM authority.scope_instance WHERE id=$1", [scope_id]))[0];
    if (!owner) return null;
    const executions = await tx.query<ExecutionRecord>("SELECT * FROM authority.execution WHERE scope_id=$1 ORDER BY id", [scope_id]);
    const resources = await tx.query<ResourceBindingRecord>("SELECT * FROM authority.resource_binding WHERE scope_id=$1 ORDER BY id", [scope_id]);
    const effects = await tx.query<{ id: string; effect_key: string; status: string; version: number }>("SELECT id,effect_key,status,version FROM authority.effect_intent WHERE scope_id=$1 ORDER BY id", [scope_id]);
    return { scope_id, scope_version: Number(owner.version), executions, resources, effects };
  }, "repeatable read");
}
