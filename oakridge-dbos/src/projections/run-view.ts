import type { DefinitionBundle } from "../core-client/generated-contracts";
import type { RunId, RunRecord, ScopeInstanceRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { selectAvailableCommands } from "./scope-view";

export interface RunScopeSummary { readonly scope_id: string; readonly scope_key: string; readonly label: string; readonly version: number; readonly is_terminal: boolean; readonly available_commands: readonly string[] }
export interface RunView { readonly run_id: RunId; readonly definition_bundle_id: string; readonly definition_digest: string; readonly version: number; readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly scopes: readonly RunScopeSummary[] }
export async function readRunView(db: TransactionalSqlExecutor, run_id: RunId): Promise<RunView | null> {
  return db.transaction(async (tx) => {
    const run = (await tx.query<RunRecord>("SELECT * FROM authority.run WHERE id=$1", [run_id]))[0];
    if (!run) return null;
    const pinned = (await tx.query<{ source: DefinitionBundle; digest: string }>("SELECT source,digest FROM authority.definition_bundle WHERE id=$1", [run.definition_bundle_id]))[0];
    if (!pinned) throw new Error(`pinned definition missing for ${run_id}`);
    const scopes = await tx.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE run_id=$1 ORDER BY id", [run_id]);
    return { run_id, definition_bundle_id: run.definition_bundle_id, definition_digest: pinned.digest, version: Number(run.version),
      cursor: scopes.map((scope) => ({ scope_id: scope.id, version: Number(scope.version) })),
      scopes: scopes.map((scope) => ({ scope_id: scope.id, scope_key: scope.scope_key,
        label: pinned.source.scopes.find((item) => item.key === scope.scope_key)?.presentation.label ?? scope.scope_key,
        version: Number(scope.version), is_terminal: scope.is_terminal,
        available_commands: selectAvailableCommands(pinned.source, scope).map((item) => item.key) })) };
  }, "repeatable read");
}
