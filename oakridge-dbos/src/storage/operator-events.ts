import type { OperatorEventPayload } from "./json-column-types";
import { selectRunEvent, type AuthorityEventRow } from "../projections/run-event";
import type { RunId } from "./schema-records";
import type { SqlExecutor } from "./sql-executor";

/**
 * A UI outbox write, not authority state. These rows are never read by the
 * evaluator and never replayed through `step`; they exist so the operator
 * stream can announce registry and visibility writes that are not domain
 * events. The caller supplies the transaction writing the causing mutation.
 */
export async function writeOperatorEvent(tx: SqlExecutor, run_id: RunId | null, run_key: string, payload: OperatorEventPayload): Promise<void> {
  await tx.query("INSERT INTO authority.operator_event (id,run_id,run_key,event_key,payload) VALUES ($1,$2,$3,$4,$5)",
    [crypto.randomUUID(), run_id, run_key, payload.kind, JSON.stringify(payload)]);
}

/**
 * The committed event, its unit's resulting status, and that unit's oldest open
 * operator review — the three things a run_event frame reports. Written in the
 * committing transaction so the stream's cursor can never skip a frame.
 */
export async function writeRunEventFrame(tx: SqlExecutor, run_id: RunId, event_id: string): Promise<void> {
  const rows = await tx.query<AuthorityEventRow>(`SELECT e.id,e.run_id,e.unit_id,u.declaration AS unit_key,e.payload,
      u.status AS unit_status, review.id AS attention_review, review.body->>'title' AS attention_label,
      to_jsonb(e.created_at)#>>'{}' AS created_at
    FROM authority.event e
    LEFT JOIN authority.unit u ON u.run_id=e.run_id AND u.id=e.unit_id
    LEFT JOIN LATERAL (
      SELECT r.id,r.body FROM authority.review_item r
      WHERE r.run_id=e.run_id AND r.unit_id=e.unit_id AND r.body->>'status'='open'
      ORDER BY r.created_at,r.id LIMIT 1
    ) review ON true
    WHERE e.id=$1 AND e.run_id=$2`, [event_id, run_id]);
  const row = rows[0];
  if (!row) return;
  await writeOperatorEvent(tx, run_id, run_id, { kind: "run_event", data: selectRunEvent(row) });
}
