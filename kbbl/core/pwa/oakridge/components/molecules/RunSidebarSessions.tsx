import type { Sid } from "../../../lib/ids";
import type { RunWorkspaceSlot } from "../../lib/run-workspace";
import type { RunSidebarSessionRow } from "../../lib/run-overview";

interface RunSidebarSessionsProps {
  rows: readonly RunSidebarSessionRow[];
  /** Whether the gate read answered. When it did not, no row can carry "needs you". */
  isActionStateKnown: boolean;
  /** Whether the attempt read answered. When it did not, no row exists to show. */
  isSessionListKnown: boolean;
  /** Sessions currently on screen in either slot, so the list can mark them. */
  openSessionIds: ReadonlySet<string>;
  onOpen: (sessionId: Sid, slot: RunWorkspaceSlot) => void;
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
  onOpen,
}: RunSidebarSessionsProps) {
  return (
    <section className="or-run-sidebar__section" data-testid="or-sidebar-sessions">
      <h3 className="or-run-sidebar__heading">Sessions</h3>
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
      <ul className="or-run-sidebar__list">
        {rows.map((row) => (
          <li key={row.work_order_id} className="or-run-sidebar__row">
            <button
              type="button"
              className={`or-run-sidebar__row-open ${openSessionIds.has(row.session_id) ? "or-run-sidebar__row-open--active" : ""}`}
              onClick={() => onOpen(row.session_id, "primary")}
              data-testid="or-sidebar-session"
              data-session-id={row.session_id}
              data-current={row.is_current}
            >
              <span className="or-run-sidebar__row-title">
                {row.stage_key}
                <span className="or-run-sidebar__row-unit">{row.unit_id}</span>
              </span>
              <span className="or-run-sidebar__row-meta">
                <span data-testid="or-sidebar-session-state">{row.work_order_state}</span>
                <span data-testid="or-sidebar-session-attempt">{row.attempt_label}</span>
                {row.is_current ? (
                  <span className="text-[var(--success-fg)]" data-testid="or-sidebar-session-current">
                    current
                  </span>
                ) : (
                  <span className="text-[var(--text-faint)]" data-testid="or-sidebar-session-superseded">
                    superseded
                  </span>
                )}
                {row.requires_operator_action && (
                  <span
                    className="text-[var(--amber-fg)]"
                    data-testid="or-sidebar-session-action-required"
                  >
                    needs you
                  </span>
                )}
              </span>
            </button>
            <button
              type="button"
              className="or-run-sidebar__row-twin"
              onClick={() => onOpen(row.session_id, "secondary")}
              aria-label={`Open ${row.stage_key} ${row.unit_id} in the second pane`}
              data-testid="or-sidebar-session-twin"
            >
              ⧉
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
