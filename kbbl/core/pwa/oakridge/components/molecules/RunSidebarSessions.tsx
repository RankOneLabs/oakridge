import type { Sid } from "../../../lib/ids";
import type { RunWorkspaceSlot } from "../../lib/run-workspace";
import type { RunSidebarSessionRow } from "../../lib/run-overview";

interface RunSidebarSessionsProps {
  rows: readonly RunSidebarSessionRow[];
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
 */
export function RunSidebarSessions({ rows, openSessionIds, onOpen }: RunSidebarSessionsProps) {
  return (
    <section className="or-run-sidebar__section" data-testid="or-sidebar-sessions">
      <h3 className="or-run-sidebar__heading">Sessions</h3>
      {rows.length === 0 && (
        <p className="or-run-sidebar__empty" data-testid="or-sidebar-sessions-empty">
          No sessions yet.
        </p>
      )}
      <ul className="or-run-sidebar__list">
        {rows.map((row) => (
          <li key={row.session_id} className="or-run-sidebar__row">
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
