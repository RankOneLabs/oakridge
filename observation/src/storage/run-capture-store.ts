import type { JsonValue } from "../domain/primitives";
import { withTenant, type Database, type TenantScope } from "./database";

/** The launch delivery is the durable input a run was captured with; no other record restates it. */
export async function readCapturedRunInput(db: Database, tenant: TenantScope, run_id: string): Promise<JsonValue | null> {
  const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_event_outcome").select("detail")
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("run_id", "=", run_id).where("outcome_kind", "=", "run_input").executeTakeFirst());
  const detail = row?.detail;
  return detail !== null && typeof detail === "object" && !Array.isArray(detail) && "input" in detail
    ? (detail as { readonly input: JsonValue }).input : null;
}
