import type { DefinitionBundle, CompiledBundle } from "../core-client/generated-contracts";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

export interface PinnedDefinition { readonly bundle_id: string; readonly digest: string; readonly source: DefinitionBundle; readonly checked_program: CompiledBundle }
export interface DefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly source: DefinitionBundle }
export async function listDefinitions(db: TransactionalSqlExecutor): Promise<readonly DefinitionSummary[]> {
  return db.query<DefinitionSummary>("SELECT id AS bundle_id,digest,source FROM authority.definition_bundle ORDER BY id DESC", []);
}
export async function readPinnedDefinition(db: TransactionalSqlExecutor, run_id: string): Promise<PinnedDefinition | null> {
  const rows = await db.query<PinnedDefinition>(`SELECT b.id AS bundle_id,b.digest,b.source,b.checked_program
    FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1`, [run_id]);
  return rows[0] ?? null;
}
