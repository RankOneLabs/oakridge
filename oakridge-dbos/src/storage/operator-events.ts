import type { OperatorEventPayload } from "../projections/operator-event";
import type { RunId } from "./schema-records";
import type { SqlExecutor } from "./sql-executor";

/** The caller supplies the transaction that is writing the causing mutation. */
export async function writeOperatorEvent(tx: SqlExecutor, run_id: RunId | null, run_key: string, payload: OperatorEventPayload): Promise<void> {
  await tx.query("INSERT INTO authority.operator_event (id,run_id,run_key,event_key,payload) VALUES ($1,$2,$3,$4,$5)",
    [crypto.randomUUID(), run_id, run_key, payload.kind, JSON.stringify(payload)]);
}
