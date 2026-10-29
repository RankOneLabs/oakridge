import type { Database, TenantScope } from "../storage/database";
import { purgeRun, type PurgeError, type PurgeRecord } from "./purge";
import { ok, type Result } from "../domain/primitives";

/** Producer-attested read: Oakridge checks authority.run using its own DB handle. */
export interface OperatorEventDelivery {
  readonly id: string;
  readonly run_key: string;
  readonly payload: { readonly kind: string; readonly data?: { readonly target?: string; readonly run_id?: string | null } };
  readonly run_exists: boolean;
  readonly operator_override: boolean;
}
export function deletedRunId(event: OperatorEventDelivery): string | null {
  if (event.payload.kind !== "invalidate" || event.payload.data?.target !== "run") return null;
  const run_id = event.payload.data.run_id;
  return typeof run_id === "string" && run_id.length > 0 && event.run_key === run_id && !event.run_exists ? run_id : null;
}
export async function handleOperatorEvent(db: Database, tenant: TenantScope, event: OperatorEventDelivery):
  Promise<Result<PurgeRecord | null, PurgeError>> {
  const run_id = deletedRunId(event);
  if (run_id === null) return ok(null);
  return purgeRun(db, { tenant, run_id, trigger_event_id: event.id, trigger_run_key: event.run_key,
    operator_override: event.operator_override });
}
