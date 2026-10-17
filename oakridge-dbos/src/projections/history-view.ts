import type { Event, Writer } from "../core-client/core-types";
import type { UnitId } from "../domain/primitives";
import type { AuthorityEffectStatus } from "../storage/db-types";
import type { HistoryPage, UnitDiagnosticsRead } from "../storage/read-store";
import { selectAttemptViews, type AttemptView } from "./unit-view";

/** One event that addressed the unit. */
export interface EventHistory {
  readonly id: string;
  /** The ingress id the event was committed under; null for an event with none. */
  readonly ingress_id: string | null;
  readonly event: Event;
  readonly writer: Writer;
  readonly created_at: Date;
}
/** The events that addressed a unit, newest first, paged. */
export interface UnitHistory { readonly unit_id: UnitId; readonly events: readonly EventHistory[]; readonly next_cursor: string | null }

export function selectUnitHistory(unit_id: UnitId, page: HistoryPage, next_cursor: string | null): UnitHistory {
  return { unit_id, next_cursor, events: page.items.map(({ event }) => ({ id: event.id, ingress_id: event.ingress_id, event: event.payload,
    writer: event.writer, created_at: event.created_at })) };
}

/** What the executor has made of one effect intent. */
export interface EffectDiagnostic {
  readonly id: string;
  readonly action_id: string;
  readonly seq: number;
  readonly status: AuthorityEffectStatus;
  readonly tries: number;
  readonly next_try_at: Date | null;
  readonly last_error: string | null;
  readonly updated_at: Date;
}
export interface RejectedEvent { readonly ingress_id: string; readonly reason: string }
/** A unit's attempts, its effect intents and the events step refused for it. */
export interface UnitDiagnostics {
  readonly unit_id: UnitId;
  readonly attempts: readonly AttemptView[];
  readonly effects: readonly EffectDiagnostic[];
  /** Events step refused for this unit. */
  readonly rejected: readonly RejectedEvent[];
}

export function selectUnitDiagnostics(read: UnitDiagnosticsRead): UnitDiagnostics {
  return { unit_id: read.unit.id, attempts: selectAttemptViews(read.attempts),
    effects: read.intents.map((intent) => ({ id: intent.id, action_id: intent.action_id, seq: intent.seq, status: intent.status, tries: intent.tries,
      next_try_at: intent.next_try_at, last_error: intent.last_error, updated_at: intent.updated_at })),
    rejected: read.rejected.flatMap((receipt) => receipt.result.kind === "rejected" ? [{ ingress_id: receipt.ingress_id, reason: receipt.result.reason }] : []) };
}
