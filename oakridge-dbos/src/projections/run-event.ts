import type { Event, UnitStatus } from "../core-client/core-types";
import type { RunId, UnitId } from "../domain/primitives";

/** One committed event as the operator event stream delivers it (GET /events). */
export interface RunEvent {
  readonly event_id: string;
  readonly run_id: RunId;
  /** The unit the event addressed; null for a launch or a cancel. */
  readonly unit_id: UnitId | null;
  readonly kind: Event["kind"];
  readonly run_status: UnitStatus["kind"];
  /** ISO-8601, as the event log recorded it. */
  readonly occurred_at: string;
}
/** Resume position in the operator outbox: the last delivered row, by writing transaction then id. */
export interface RunEventCursor { readonly commit_txid: string; readonly id: string }
