import { err, ok, type Result } from "../domain/primitives";
import type { SqlExecutor } from "./sql-executor";

interface LegacyTopologyInventoryRow {
  readonly legacy_stage_count: string;
}

export interface LegacyTopologyInventory {
  readonly legacy_stage_count: number;
}

export interface CutoverDatabaseError {
  readonly operation: "require_v2_cutover_database";
  readonly kind: "legacy_topology_present";
  readonly detail: string;
  readonly inventory: LegacyTopologyInventory;
}

/**
 * Refuses the one unsupported deployment shape: application rows authored by
 * the deleted coordinator topology. A healthy v2 database may be restarted
 * with existing runs; their stages are run-owned rather than attempt-owned.
 *
 * The legacy attempt-tracking table is gone as of migration 0019, so an
 * attempt-namespace count is no longer a signal this check can read; an
 * attempt-owned `stage_instance` row is the one signal that survives.
 */
export const requireV2CutoverDatabase = async (sql: SqlExecutor): Promise<Result<LegacyTopologyInventory, CutoverDatabaseError>> => {
  const [row] = await sql.query<LegacyTopologyInventoryRow>(
    `SELECT
       (SELECT count(*)::text FROM oakridge.stage_instance WHERE attempt_root_workflow_id IS NOT NULL) AS legacy_stage_count`,
    [],
  );
  const inventory = {
    legacy_stage_count: Number(row?.legacy_stage_count ?? 0),
  };
  if (inventory.legacy_stage_count === 0) return ok(inventory);
  return err({
    operation: "require_v2_cutover_database",
    kind: "legacy_topology_present",
    detail: `Oakridge v2 cannot start in place over legacy application data (${inventory.legacy_stage_count} attempt-owned stage(s)); recreate the application database and migrate from zero`,
    inventory,
  });
};
