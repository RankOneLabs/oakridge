// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorEvent, OperatorUnitStatus } from "../core-client/core-types";

export interface OperatorRunEvent {
  readonly event_id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly unit_key: string;
  readonly kind: OperatorEvent["kind"];
  readonly awaiting: OperatorAwaitingReviewNotice | null;
  /** The addressed unit is done or cancelled. */
  readonly is_terminal: boolean;
  readonly run_status: OperatorUnitStatus["kind"];
  /** ISO-8601, as the event log recorded it. */
  readonly occurred_at: string;
}

export interface OperatorAwaitingReviewNotice { readonly review: string; readonly label: string }
