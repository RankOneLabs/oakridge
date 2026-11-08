import { sql } from "kysely";
import type { JsonValue } from "../domain/primitives";
import type { RunConfigWire } from "../ingest/cursor";
import { withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";

/** The launch delivery is the durable input a run was captured with; no other record restates it. */
export async function readCapturedRunInput(db: Database, tenant: TenantScope, run_id: string): Promise<JsonValue | null> {
  const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_event_outcome").select("detail")
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("run_id", "=", run_id).where("outcome_kind", "=", "run_input").executeTakeFirst());
  const detail = row?.detail;
  return detail !== null && typeof detail === "object" && !Array.isArray(detail) && "input" in detail
    ? (detail as { readonly input: JsonValue }).input : null;
}

/** The run's own automatic-grading choice, from the config its launch delivered. A launch that
 * carried no config, or a run whose launch was never captured, has grading off. */
export const runGradingEnabled = sql<boolean>`EXISTS (SELECT 1 FROM observation.source_event_outcome launch
  WHERE launch.producer = i.producer AND launch.namespace = i.namespace AND launch.run_id = i.run_id
    AND launch.outcome_kind = 'run_input' AND launch.detail->'config'->'grading_enabled' = 'true'::jsonb)`;

export async function isRunGradingEnabled(trx: DatabaseTransaction, tenant: TenantScope, run_id: string): Promise<boolean> {
  const row = await trx.selectFrom("observation.source_event_outcome").select("outcome_kind")
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("run_id", "=", run_id)
    .where("outcome_kind", "=", "run_input").where(sql<boolean>`detail->'config'->'grading_enabled' = 'true'::jsonb`).executeTakeFirst();
  return row !== undefined;
}

/** The exact config the run's launch delivered, as captured; null when the launch carried none or
 * was never captured. */
export async function readCapturedRunConfig(trx: DatabaseTransaction, tenant: TenantScope, run_id: string): Promise<RunConfigWire | null> {
  const row = await trx.selectFrom("observation.source_event_outcome").select(sql<RunConfigWire | null>`detail->'config'`.as("config"))
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("run_id", "=", run_id)
    .where("outcome_kind", "=", "run_input").executeTakeFirst();
  return row?.config ?? null;
}
