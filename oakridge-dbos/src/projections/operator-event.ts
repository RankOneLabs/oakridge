import type { InvalidationTarget, OperatorEventPayload } from "../storage/json-column-types";
import type { RunId } from "../storage/schema-records";
import type { RunEvent } from "./run-event";

export type { OperatorEventPayload, InvalidationTarget };

export interface OperatorEventRow {
  readonly id: string;
  readonly commit_txid: string;
  readonly event_key: OperatorEventPayload["kind"];
  readonly payload: OperatorEventPayload;
}

/** An outbox row annotated with visibility in the subscriber's starting snapshot. */
export interface OperatorEventDeliveryRow extends OperatorEventRow {
  readonly was_visible_at_subscription: boolean;
}

export type OperatorFrame =
  | { readonly event: "run_event"; readonly data: RunEvent }
  | { readonly event: "invalidate"; readonly data: { readonly kind: "invalidate"; readonly target: InvalidationTarget; readonly run_id: RunId | null } };

export function selectOperatorFrame(row: OperatorEventRow): OperatorFrame {
  if (row.event_key === "run_event" && row.payload.kind === "run_event") return { event: "run_event", data: row.payload.data };
  if (row.event_key === "invalidate" && row.payload.kind === "invalidate") return { event: "invalidate", data: { kind: "invalidate", ...row.payload.data } };
  throw new Error(`operator event ${row.id} has a mismatched payload`);
}
