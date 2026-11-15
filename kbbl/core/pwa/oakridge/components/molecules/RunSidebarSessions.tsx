import { Button } from "../../../components/atoms/Button";
import { useState, type ReactNode } from "react";

import { selectRunSidebarSessionVisibility, type RunSidebarSessionRow } from "../../lib/run-overview";

interface RunSidebarSessionsProps {
  rows: readonly RunSidebarSessionRow[];
  /** Whether the gate read answered. When it did not, no row can carry "needs you". */
  isActionStateKnown: boolean;
  /** Whether the attempt read answered. When it did not, no row exists to show. */
  isSessionListKnown: boolean;
  /** Sessions currently on screen in either slot, so the list can mark them. */
  openSessionIds: ReadonlySet<string>;
  renderRow: (row: RunSidebarSessionRow, isOpen: boolean) => ReactNode;
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
  rows,
  isActionStateKnown,
  isSessionListKnown,
  openSessionIds,
  renderRow,
}: RunSidebarSessionsProps) {
  const [showArchived, setShowArchived] = useState(false);
  const visibility = selectRunSidebarSessionVisibility(rows, showArchived);
  return (
    <section className="or-run-sidebar__section" data-testid="or-sidebar-sessions">
      <h3 className="or-run-sidebar__heading">Sessions</h3>
      {visibility.archived_count > 0 && (
        <Button variant="secondary"
          type="button"
          className="self-start text-xs!"
          onClick={() => setShowArchived((current) => !current)}
          aria-expanded={showArchived}
          data-testid="or-sidebar-archived-toggle"
        >
          {showArchived ? "Hide archived sessions" : `Show all sessions (${visibility.archived_count} archived)`}
        </Button>
      )}
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
        {visibility.visible_rows.map((row) => renderRow(row, openSessionIds.has(row.session_id)))}
      </ul>
    </section>
  );
}
