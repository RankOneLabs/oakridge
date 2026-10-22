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
/** Unconditional navigation target for a session, whether its attempt is running or ended. */
export interface SessionRunLocation { readonly run_id: RunId; readonly unit_id: UnitId }
export interface SessionHoldResponse { readonly hold: SessionHold | null; readonly location: SessionRunLocation | null }
