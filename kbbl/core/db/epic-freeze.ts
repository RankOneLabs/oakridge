import { Database } from "bun:sqlite";

/**
 * Returns true when the Epic is archived (write operations should be rejected).
 * Handlers operating on non-Epic artifacts resolve epic_id via the FK chain
 * (artifact → spec → epic) before calling this function.
 *
 * Note: archive does NOT auto-kill running sessions; the operator stops them
 * manually via DELETE /sessions/:sid. This function only gates future writes.
 */
export function isFrozen(db: Database, epic_id: string): boolean {
  const row = db
    .prepare<{ status: string }, [string]>("SELECT status FROM epics WHERE id = ?")
    .get(epic_id);
  return row?.status === "archived";
}
