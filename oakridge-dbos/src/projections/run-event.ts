import type { Event as CoreEvent, UnitStatus } from "../core-client/core-types";
import type { RunId, UnitId } from "../storage/schema-records";

/** A unit that now waits on an operator decision, named so the UI can label it. */
export interface RunAttention { readonly review: string; readonly label: string }

/** One committed authority event as the operator stream delivers it (GET /events). */
export interface RunEvent {
  readonly event_id: string;
  readonly run_id: RunId;
  readonly unit_id: UnitId | null;
  /** The unit's declaration key; null for run-scoped events such as launch. */
  readonly unit_key: string | null;
  /** The v2 event that caused this frame, replacing v1's decision outcome kind. */
  readonly kind: CoreEvent["kind"];
  readonly attention: RunAttention | null;
  /** The affected unit reached a terminal status in this event's transaction. */
  readonly is_terminal: boolean;
  /** ISO-8601, as authority.event recorded it. */
  readonly occurred_at: string;
}

/** Resume position in the operator outbox: the last delivered row, by writing transaction then id. */
export interface RunEventCursor { readonly commit_txid: string; readonly id: string }

/**
 * An authority.event row joined to the unit it affected and that unit's
 * oldest open operator review, which is what v1 carried as attention metadata.
 */
export interface AuthorityEventRow {
  readonly id: string;
  readonly run_id: RunId;
  readonly unit_id: UnitId | null;
  readonly unit_key: string | null;
  readonly payload: CoreEvent;
  readonly unit_status: UnitStatus | null;
  readonly attention_review: string | null;
  readonly attention_label: string | null;
  readonly created_at: string;
}

const isTerminal = (status: UnitStatus | null): boolean =>
  status !== null && (status.kind === "done" || status.kind === "cancelled");

export function selectRunEvent(row: AuthorityEventRow): RunEvent {
  return {
    event_id: row.id,
    run_id: row.run_id,
    unit_id: row.unit_id,
    unit_key: row.unit_key,
    kind: row.payload.kind,
    attention: row.attention_review !== null && row.attention_label !== null
      ? { review: row.attention_review, label: row.attention_label } : null,
    is_terminal: isTerminal(row.unit_status),
    occurred_at: row.created_at,
  };
}
