import type { Event, UnitStatus, Workflow } from "../core-client/core-types";
import type { RunId, UnitId } from "../domain/primitives";
import { selectUnitLabel, type LabelledUnit } from "./unit-label";

/** A review that began awaiting the operator with the event. */
export interface AwaitingReviewNotice { readonly review: string; readonly label: string }
/**
 * One committed event as the operator event stream delivers it (GET /events).
 * A launch or a cancel addresses the run's root unit.
 */
export interface RunEvent {
  readonly event_id: string;
  readonly run_id: RunId;
  readonly unit_id: UnitId;
  readonly unit_key: string;
  readonly kind: Event["kind"];
  readonly awaiting: AwaitingReviewNotice | null;
  /** The addressed unit is done or cancelled. */
  readonly is_terminal: boolean;
  readonly run_status: UnitStatus["kind"];
  /** ISO-8601, as the event log recorded it. */
  readonly occurred_at: string;
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
  const awaiting = review === undefined ? null
    : { review, label: `${selectUnitLabel(source.unit, source.workflow)}: awaiting ${review} review` };
  return { event_id: source.event_id, run_id: source.run_id, unit_id: source.unit.id, unit_key: source.unit.unit_key, kind: source.kind, awaiting,
    is_terminal: source.unit.status.kind === "done" || source.unit.status.kind === "cancelled",
    run_status: source.run_status.kind, occurred_at: source.occurred_at.toISOString() };
}
