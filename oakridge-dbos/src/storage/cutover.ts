import { err, ok, type Result } from "../domain/primitives";
import type { SqlExecutor } from "./sql-executor";

interface LegacyTopologyInventoryRow {
  readonly legacy_attempt_count: string;
  readonly legacy_stage_count: string;
}

export interface LegacyTopologyInventory {
  readonly legacy_attempt_count: number;
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
 * with existing runs; their launch attempts use the `v2-run:` namespace and
 * their stages are run-owned rather than attempt-owned.
 */
export const requireV2CutoverDatabase = async (sql: SqlExecutor): Promise<Result<LegacyTopologyInventory, CutoverDatabaseError>> => {
  const [row] = await sql.query<LegacyTopologyInventoryRow>(
    `SELECT
       (SELECT count(*)::text FROM oakridge.workflow_attempt WHERE root_workflow_id NOT LIKE 'v2-run:%') AS legacy_attempt_count,
       (SELECT count(*)::text FROM oakridge.stage_instance WHERE attempt_root_workflow_id IS NOT NULL) AS legacy_stage_count`,
    [],
  );
  const inventory = {
    legacy_attempt_count: Number(row?.legacy_attempt_count ?? 0),
    legacy_stage_count: Number(row?.legacy_stage_count ?? 0),
  };
  if (inventory.legacy_attempt_count === 0 && inventory.legacy_stage_count === 0) return ok(inventory);
  return err({
    operation: "require_v2_cutover_database",
    kind: "legacy_topology_present",
    detail: `Oakridge v2 cannot start in place over legacy application data (${inventory.legacy_attempt_count} legacy attempt(s), ${inventory.legacy_stage_count} attempt-owned stage(s)); recreate the application database and migrate from zero`,
    inventory,
  });
};
