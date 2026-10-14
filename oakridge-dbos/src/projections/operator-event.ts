import type { Event } from "../core-client/core-types";
import type { RunId, UnitId } from "../domain/primitives";
import type { RunEvent } from "./run-event";

/**
 * A commit that faulted on an event (an inconsistency the core or commit
 * found, D-V4). The transaction rolled back, so it is recorded on its own,
 * against the run, and stands as a stall does: while `after_event` is still
 * the latest event committed on its unit.
 */
export interface CommitFaultNotice {
  readonly run_id: RunId;
  /** The unit the event addressed; null for a launch or a cancel, which address the run. */
  readonly unit_id: UnitId | null;
  /** The unit the core was advancing when it found the fault, when it names one: where the fault is shown. */
  readonly at_unit: UnitId | null;
  readonly ingress_id: string | null;
  readonly event: Event;
  readonly detail: string;
  /** The latest event committed on that unit (on the run, for null) when it faulted; null when there was none. */
  readonly after_event: string | null;
}

/** The payloads persisted in authority.operator_event. */
export type OperatorEventPayload =
  | { readonly kind: "run_event"; readonly data: RunEvent }
  | { readonly kind: "invalidate"; readonly data: { readonly target: "run" | "runs" | "definitions" | "projects"; readonly run_id: RunId | null } }
  | { readonly kind: "commit_fault"; readonly data: CommitFaultNotice };

export interface OperatorEventRow {
  readonly id: string;
  readonly commit_txid: string;
  readonly payload: OperatorEventPayload;
}

/** An outbox row annotated with visibility in the subscriber's starting snapshot. */
export interface OperatorEventDeliveryRow extends OperatorEventRow {
  readonly was_visible_at_subscription: boolean;
}

/** What an invalidate frame tells subscribers to refetch. */
export interface StreamInvalidation { readonly kind: "invalidate"; readonly target: "run" | "runs" | "definitions" | "projects"; readonly run_id: RunId | null }
export type StreamFrame =
  | { readonly event: "run_event"; readonly data: RunEvent }
  | { readonly event: "invalidate"; readonly data: StreamInvalidation };
/** A frame's data as GET /events sends it: `replay` marks a row a reconnecting subscriber had already seen. */
export type StreamFrameData = StreamFrame["data"] & { readonly replay: boolean };

/** The frame an outbox row streams as, read from its payload. */
export function selectOperatorFrame(row: OperatorEventRow): StreamFrame {
  const { payload } = row;
  switch (payload.kind) {
    case "run_event": return { event: "run_event", data: payload.data };
    case "invalidate": return { event: "invalidate", data: { kind: "invalidate", ...payload.data } };
    // A fault changes what the run's attention shows, not its state: the run's views refresh.
    case "commit_fault": return { event: "invalidate", data: { kind: "invalidate", target: "run", run_id: payload.data.run_id } };
  }
}
