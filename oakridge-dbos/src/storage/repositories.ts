import type { DefinitionBundleRecord, RunRecord, ScopeId, ScopeInstanceRecord } from "./schema-records";
import type { SqlExecutor } from "./sql-executor";

export interface AuthorityRepositories {
  bundle(id: string): Promise<DefinitionBundleRecord | null>;
  run(id: string): Promise<RunRecord | null>;
  scope(id: ScopeId): Promise<ScopeInstanceRecord | null>;
}
export function authorityRepositories(db: SqlExecutor): AuthorityRepositories {
  return {
    async bundle(id) { return (await db.query<DefinitionBundleRecord>("SELECT * FROM authority.definition_bundle WHERE id=$1", [id]))[0] ?? null; },
    async run(id) { return (await db.query<RunRecord>("SELECT * FROM authority.run WHERE id=$1", [id]))[0] ?? null; },
    async scope(id) { return (await db.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE id=$1", [id]))[0] ?? null; },
  };
}
