import { type PaneSlots } from "../../lib/pane-selection";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { selectBulkHideActionLabel, selectBulkHideFailureMessage, type BulkHideOutcome } from "../../../lib/session-bulk-hide";
import { Button } from "../../../components/atoms/Button";
import { useState, type ReactNode } from "react";

import { selectRunSidebarSessionVisibility, type RunSidebarSessionRow } from "../../lib/run-overview";

export interface RunHideEndedControl {
  eligibleCount: number;
  isArmed: boolean;
  isPending: boolean;
  outcome: BulkHideOutcome | undefined;
  onPress: () => void;
}

interface RunSidebarSessionsProps {
  hideEnded: RunHideEndedControl;
  rows: readonly RunSidebarSessionRow[];
  /** Whether the gate read answered. When it did not, no row can carry "needs you". */
  isActionStateKnown: boolean;
  /** Whether the attempt read answered. When it did not, no row exists to show. */
  isSessionListKnown: boolean;
  /** Sessions currently on screen in either slot, so the list can mark them. */
  slotsOf: (id: string) => PaneSlots;
  renderRow: (row: RunSidebarSessionRow, slots: PaneSlots) => ReactNode;
}

/**
 * Every session of the run — prior attempts included — in the order the route
 * returned them.
 *
 * Presentational: rows arrive already derived by `selectRunSidebarSessions`,
 * and the component speaks session ids rather than panes so the pane model
 * stays the host's concern.
 *
 * An unread gate list and a run with nothing open produce the same rows — no
 * "needs you" anywhere — so the section says which one it is rather than let
 * the absence of markers speak for itself.
 */
export function RunSidebarSessions({
  hideEnded,
  rows,
  isActionStateKnown,
  isSessionListKnown,
  slotsOf,
  renderRow,
}: RunSidebarSessionsProps) {
  const [showArchived, setShowArchived] = useState(false);
  const visibility = selectRunSidebarSessionVisibility(rows, showArchived);
  return (
    <section className="or-run-sidebar__section" data-testid="or-sidebar-sessions">
      <h3 className="or-run-sidebar__heading">Sessions</h3>
      <div className="flex flex-wrap items-center gap-2" data-testid="or-sidebar-session-controls">
        <Button variant="secondary" type="button" className="text-xs!"
          onClick={() => setShowArchived((current) => !current)}
          aria-pressed={showArchived} data-testid="or-sidebar-archived-toggle">
          Show all
        </Button>
        {visibility.archived_count > 0 && <span>({visibility.archived_count} archived)</span>}
        <Button variant={hideEnded.isArmed ? "armed" : "secondary"} type="button"
          disabled={hideEnded.eligibleCount === 0 || hideEnded.isPending}
          onClick={hideEnded.onPress} data-testid="or-sidebar-hide-ended">
          {selectBulkHideActionLabel(hideEnded.eligibleCount, hideEnded.isArmed)}
        </Button>
      </div>
      {hideEnded.outcome && <>
        <FeedbackMessage testId="or-sidebar-hide-ended-outcome">
          Archived {hideEnded.outcome.archivedSids.length} of {hideEnded.outcome.eligibleCount}: {hideEnded.outcome.archivedSids.length ? hideEnded.outcome.archivedSids.join(", ") : "none"}.
        </FeedbackMessage>
        {hideEnded.outcome.failures.map((failure) => <FeedbackMessage key={failure.sid} tone="danger">{selectBulkHideFailureMessage(failure)}</FeedbackMessage>)}
      </>}
      {!isActionStateKnown && (
        <p
          className="or-run-sidebar__empty text-[var(--amber-fg)]"
          role="status"
          data-testid="or-sidebar-sessions-gates-unavailable"
        >
          Gate status unavailable
        </p>
      )}
      {!isSessionListKnown && (
        <p
          className="or-run-sidebar__empty text-[var(--amber-fg)]"
          role="status"
          data-testid="or-sidebar-sessions-unavailable"
        >
          Session list unavailable
        </p>
      )}
      {isSessionListKnown && rows.length === 0 && (
        <p className="or-run-sidebar__empty" data-testid="or-sidebar-sessions-empty">
          No sessions yet.
        </p>
      )}
      {isSessionListKnown && rows.length > 0 && visibility.visible_rows.length === 0 && (
        <p className="or-run-sidebar__empty">All sessions are archived.</p>
      )}
      <ul className="or-run-sidebar__list">
        {visibility.visible_rows.map((row) => renderRow(row, slotsOf(row.session_id)))}
      </ul>
    </section>
  );
}
