import type { DefinitionBundleRecord, RunRecord, UnitId, UnitRecord } from "./schema-records";
import type { SqlExecutor } from "./sql-executor";

export interface AuthorityRepositories {
  bundle(id: string): Promise<DefinitionBundleRecord | null>;
  run(id: string): Promise<RunRecord | null>;
  unit(run_id: string, id: UnitId): Promise<UnitRecord | null>;
}
export function authorityRepositories(db: SqlExecutor): AuthorityRepositories {
  return {
    async bundle(id) { return (await db.query<DefinitionBundleRecord>("SELECT * FROM authority.definition_bundle WHERE id=$1", [id]))[0] ?? null; },
    async run(id) { return (await db.query<RunRecord>("SELECT * FROM authority.run WHERE id=$1", [id]))[0] ?? null; },
    async unit(run_id, id) { return (await db.query<UnitRecord>("SELECT * FROM authority.unit WHERE run_id=$1 AND id=$2", [run_id, id]))[0] ?? null; },
  };
}
