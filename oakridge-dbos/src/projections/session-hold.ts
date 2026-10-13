import type { RunId, UnitId } from "../domain/primitives";

/**
 * The running attempt that holds a kbbl session (GET /session_holds/:session_id).
 * kbbl refuses to close a held session unless the close comes from that
 * attempt (`fenced_by` or `closed_by` naming its action) or the operator
 * overrides the refusal.
 */
export interface SessionHold {
  readonly session_id: string;
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly worker: string;
  /** The attempt's action id: the identity its own close carries. */
  readonly action_id: string;
}
export interface SessionHoldResponse { readonly hold: SessionHold | null }
