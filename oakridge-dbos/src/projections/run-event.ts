import type { Event, UnitStatus, Workflow } from "../core-client/core-types";
import type { RunId, UnitId } from "../domain/primitives";
import { selectUnitLabel, type LabelledUnit } from "./unit-label";

/** Set when the event leaves a review awaiting the operator (v1 `AttentionMetadata`). */
export interface AttentionMetadata { readonly label: string; readonly trigger: string }
/**
 * One committed event as the operator event stream delivers it (GET /events),
 * in v1's `RunEvent` shape renamed per rescue spec §2.3. A launch or a cancel
 * addresses the run's root unit.
 */
export interface RunEvent {
  readonly event_id: string;
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly unit_key: string;
  /** `wait` when the event left a review awaiting the operator, otherwise `apply`. */
  readonly decision: "apply" | "wait";
  readonly attention: AttentionMetadata | null;
  /** The addressed unit is done or cancelled. */
  readonly is_terminal: boolean;
  /** ISO-8601, as the event log recorded it. */
  readonly occurred_at: string;
  readonly kind: Event["kind"];
  readonly run_status: UnitStatus["kind"];
}
/** Resume position in the operator outbox: the last delivered row, by writing transaction then id. */
export interface RunEventCursor { readonly commit_txid: string; readonly id: string }

export interface RunEventSource {
  readonly event_id: string;
  readonly run_id: RunId;
  readonly kind: Event["kind"];
  readonly occurred_at: Date;
  readonly run_status: UnitStatus;
  readonly workflow: Pick<Workflow, "workflow">;
  readonly unit: LabelledUnit & { readonly id: UnitId; readonly status: UnitStatus };
  /** Reviews on the unit that began awaiting the operator with this event. */
  readonly newly_awaiting: readonly string[];
}
export function selectRunEvent(source: RunEventSource): RunEvent {
  const [review] = source.newly_awaiting;
  const attention = review === undefined ? null
    : { label: `${selectUnitLabel(source.unit, source.workflow)}: awaiting ${review} review`, trigger: review };
  return { event_id: source.event_id, run_id: source.run_id, unit_id: source.unit.id, unit_key: source.unit.unit_key,
    decision: attention ? "wait" : "apply", attention,
    is_terminal: source.unit.status.kind === "done" || source.unit.status.kind === "cancelled",
    occurred_at: source.occurred_at.toISOString(), kind: source.kind, run_status: source.run_status.kind };
}
