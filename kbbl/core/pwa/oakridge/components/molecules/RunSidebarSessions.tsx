import { Button } from "../../../components/atoms/Button";
import { useEffect, useState } from "react";

import type { Sid } from "../../../lib/ids";
import { useEndSession } from "../../../hooks/useEndSession";
import { useStore } from "../../../state/store";
import type { RunWorkspaceSlot } from "../../lib/run-workspace";
import { selectRunSidebarSessionVisibility, type RunSidebarSessionRow } from "../../lib/run-overview";

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
        {visibility.visible_rows.map((row) => (
          <RunSidebarSessionItem
            key={row.work_order_id}
            row={row}
            isOpen={openSessionIds.has(row.session_id)}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

interface RunSidebarSessionItemProps {
  row: RunSidebarSessionRow;
  isOpen: boolean;
  onOpen: (sessionId: Sid, slot: RunWorkspaceSlot) => void;
}

function RunSidebarSessionItem({ row, isOpen, onOpen }: RunSidebarSessionItemProps) {
  const [confirmEnd, setConfirmEnd] = useState(false);
  const status = useStore((state) => state.sessions.get(row.session_id)?.status ?? null);
  const canEnd = status !== null && !row.is_archived;
  const isTerminal = status === "ended" || status === "fenced" || status === "failed";
  const actionLabel = isTerminal ? "Hide" : "End and hide";
  const { mutation, error } = useEndSession(row.session_id);

  useEffect(() => {
    if (!confirmEnd) return;
    const timer = setTimeout(() => setConfirmEnd(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmEnd]);

  const end = async () => {
    if (mutation.isPending) return;
    try {
      await mutation.mutateAsync();
    } catch {
      // The mutation error is rendered with this row.
    } finally {
      setConfirmEnd(false);
    }
  };

  return (
    <li className="or-run-sidebar__row flex-wrap" data-testid="or-sidebar-session-item">
      <Button variant="sidebar-row"
        type="button"
        className={isOpen ? "border-[var(--or-run-accent,var(--accent-blue))]! bg-[var(--bg-elevated)]!" : ""}
        onClick={() => onOpen(row.session_id, "primary")}
        data-testid="or-sidebar-session"
        data-session-id={row.session_id}
        data-current={row.is_current}
      >
        <span className="or-run-sidebar__row-title">
          {row.display_label}
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
          {row.is_archived && (
            <span className="text-[var(--text-faint)]" data-testid="or-sidebar-session-archived">
              archived
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
      </Button>
      <Button variant="secondary"
        type="button"
        className="or-run-sidebar__row-twin"
        onClick={() => onOpen(row.session_id, "secondary")}
        aria-label={`Open ${row.stage_key} ${row.unit_id} in the second pane`}
        data-testid="or-sidebar-session-twin"
      >
        ⧉
      </Button>
      {canEnd && (
        <Button variant="secondary"
          type="button"
          className="or-run-sidebar__row-end"
          disabled={mutation.isPending}
          aria-label={confirmEnd ? `Confirm ${actionLabel.toLowerCase()} ${row.stage_key} ${row.unit_id}` : `${actionLabel} ${row.stage_key} ${row.unit_id}`}
          title={isTerminal
            ? "Hide this session while keeping its transcript."
            : "End and hide this session while keeping its transcript."}
          onClick={() => {
            if (!confirmEnd) setConfirmEnd(true);
            else void end();
          }}
          data-testid="or-sidebar-session-end"
        >
          {mutation.isPending ? "…" : confirmEnd ? "✓" : (
            <span className="text-xl leading-none" aria-hidden="true">×</span>
          )}
        </Button>
      )}
      {error && (
        <div className="basis-full px-2 pb-2 text-xs text-red-500" role="alert">
          <span>{error}</span>
        </div>
      )}
    </li>
  );
}
