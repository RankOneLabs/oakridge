import type { RunId } from "./schema-records";
import type { SqlExecutor } from "./sql-executor";

/** Archiving hides a run from the operator's listings; its scopes, effects and history are untouched. */
export async function setRunArchived(db: SqlExecutor, run_id: RunId, is_archived: boolean): Promise<boolean> {
  const rows = await db.query<{ id: string }>(`UPDATE authority.run SET archived_at=CASE WHEN $2 THEN coalesce(archived_at,now()) END
    WHERE id=$1 RETURNING id`, [run_id, is_archived]);
  return rows.length > 0;
}

/** An archived definition is hidden from the catalog; runs already pinned to it continue. */
export async function setDefinitionArchived(db: SqlExecutor, bundle_id: string, is_archived: boolean): Promise<boolean> {
  const rows = await db.query<{ id: string }>(`UPDATE authority.definition_bundle SET archived_at=CASE WHEN $2 THEN coalesce(archived_at,now()) END
    WHERE id=$1 RETURNING id`, [bundle_id, is_archived]);
  return rows.length > 0;
}
