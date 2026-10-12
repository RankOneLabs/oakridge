import type { UnitStatus, Workflow } from "../core-client/core-types";
import type { ReviewItemRecord, UnitRecord } from "../storage/schema-records";
import { isTerminalStatus, selectAvailableDecisions } from "./unit-view";

export type InboxItem =
  | { readonly kind: "decision"; readonly run_id: string; readonly unit_id: string; readonly unit_version: number;
      readonly review: string; readonly decision: string; readonly label: string }
  | { readonly kind: "wait"; readonly run_id: string; readonly unit_id: string; readonly unit_version: number;
      readonly reason: string; readonly label: string }
  | { readonly kind: "diagnostic"; readonly run_id: string; readonly unit_id: string; readonly unit_version: number; readonly detail: string };

/** A unit row with the pinned workflow and the unit's open operator reviews. */
export interface InboxRow extends UnitRecord {
  readonly source: Workflow | null;
  readonly open_reviews?: readonly ReviewItemRecord[] | null;
}

/** A blocked unit explains itself; any other non-terminal status is not inbox work. */
function waitLabel(status: UnitStatus): { readonly reason: string; readonly label: string } | null {
  if (status.kind !== "blocked") return null;
  return status.reason.kind === "waiting_on"
    ? { reason: "waiting_on", label: `waiting on ${status.reason.units.join(", ")}` }
    : { reason: "capacity", label: `waiting for capacity in ${status.reason.pool}` };
}

export function selectInboxItems(row: InboxRow): readonly InboxItem[] {
  const base = { run_id: row.run_id, unit_id: row.id, unit_version: Number(row.version) };
  try {
    if (!row.source || (row.stage !== null && !row.source.stages[row.stage]))
      return [{ ...base, kind: "diagnostic", detail: "pinned stage definition is unavailable" }];
    if (isTerminalStatus(row.status)) return [];
    const items: InboxItem[] = [];
    // A decision is offered only where an open review is actually waiting on it.
    if ((row.open_reviews ?? []).length > 0)
      for (const option of selectAvailableDecisions(row.source, row.stage))
        items.push({ ...base, kind: "decision", review: option.review, decision: option.decision, label: option.label });
    const wait = waitLabel(row.status);
    if (wait) items.push({ ...base, kind: "wait", reason: wait.reason, label: wait.label });
    return items;
  } catch {
    return [{ ...base, kind: "diagnostic", detail: "unit projection is damaged" }];
  }
}

export interface InboxPage {
  readonly cursor: readonly { readonly unit_id: string; readonly version: number }[];
  readonly items: readonly InboxItem[];
  readonly next_cursor: string | null;
}
/** Review work and diagnostics from the existing inbox projection. */
export type ReviewInbox = InboxPage;
