import type { Event, Writer } from "../core-client/core-types";
import type { UnitId } from "../domain/primitives";
import type { HistoryPage, IntentStanding, UnitDiagnosticsRead } from "../storage/read-store";
import { selectAttemptViews, type AttemptView } from "./unit-view";

/** v1 `TransitionHistory`: one event that addressed the unit. */
export interface EventHistory {
  readonly id: string;
  /** The ingress id the event was committed under; null for an event with none. */
  readonly trigger_id: string | null;
  /** What happened: the event itself (v1's evaluator outcome has no v2 source). */
  readonly decision: Event;
  readonly writer: Writer;
  readonly created_at: Date;
  /** The writing transaction's id: increases with commit order. */
  readonly version: number;
}
/** v1 `ScopeHistory`; `facts` are removed (R4 decision, part 1 §12). Newest first, paged. */
export interface UnitHistory { readonly unit_id: UnitId; readonly events: readonly EventHistory[]; readonly next_cursor: string | null }

export function selectUnitHistory(unit_id: UnitId, page: HistoryPage, next_cursor: string | null): UnitHistory {
  return { unit_id, next_cursor, events: page.items.map(({ event }) => ({ id: event.id, trigger_id: event.ingress_id, decision: event.payload,
    writer: event.writer, created_at: event.created_at, version: event.commit_txid })) };
}

/** v1 `EffectDiagnosticRecord`: what the executor has made of one intent. */
export interface EffectDiagnostic {
  readonly id: string;
  /** The intent's action id. */
  readonly effect_key: string;
  readonly seq: number;
  readonly status: IntentStanding["status"];
  readonly tries: number;
  readonly next_try_at: Date | null;
  readonly last_error: string | null;
  readonly updated_at: Date;
}
export interface RejectedEvent { readonly ingress_id: string; readonly reason: string }
/** v1 `ScopeDiagnostics`; `resources` and the record-version `cursor` are removed (R4 decision, part 1 §12). */
export interface UnitDiagnostics {
  readonly unit_id: UnitId;
  readonly unit_version: number;
  readonly attempts: readonly AttemptView[];
  readonly effects: readonly EffectDiagnostic[];
  /** Events step refused for this unit. */
  readonly rejected: readonly RejectedEvent[];
}

export function selectUnitDiagnostics(read: UnitDiagnosticsRead): UnitDiagnostics {
  return { unit_id: read.unit.id, unit_version: read.unit.version, attempts: selectAttemptViews(read.attempts),
    effects: read.intents.map((intent) => ({ id: intent.id, effect_key: intent.action_id, seq: intent.seq, status: intent.status, tries: intent.tries,
      next_try_at: intent.next_try_at, last_error: intent.last_error, updated_at: intent.updated_at })),
    rejected: read.rejected.flatMap((receipt) => receipt.result.kind === "rejected" ? [{ ingress_id: receipt.ingress_id, reason: receipt.result.reason }] : []) };
}
