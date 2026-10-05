import type { DefinitionBundle, CheckedProgram } from "../core-client/generated-contracts";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

export interface PinnedDefinition { readonly bundle_id: string; readonly digest: string; readonly source: DefinitionBundle; readonly checked_program: CheckedProgram }
export async function readPinnedDefinition(db: TransactionalSqlExecutor, run_id: string): Promise<PinnedDefinition | null> {
  const rows = await db.query<PinnedDefinition>(`SELECT b.id AS bundle_id,b.digest,b.source,b.checked_program
    FROM authority.definition_bundle b JOIN authority.run r ON r.definition_bundle_id=b.id WHERE r.id=$1`, [run_id]);
  return rows[0] ?? null;
}
