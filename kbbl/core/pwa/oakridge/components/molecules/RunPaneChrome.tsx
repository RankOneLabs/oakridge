import type { ReactNode } from "react";

import type { RunWorkspaceSlot } from "../../lib/run-workspace";

export interface RunPaneChromeActions {
  /**
   * Move this pane to the other slot, or null when the affordance makes no
   * sense here — nullable rather than a boolean beside a callback, so an
   * unavailable action cannot be fired by a stale handler.
   */
  readonly onOpenInOtherPane: (() => void) | null;
  readonly onClose: () => void;
}

interface RunPaneChromeProps {
  slot: RunWorkspaceSlot;
  title: string;
  subtitle: string | null;
  actions: RunPaneChromeActions;
  children: ReactNode;
}

/**
 * The frame every pane body sits in: its heading and the two affordances that
 * belong to the slot rather than to the body — close, and open in the other
 * pane. Extracted now, with only two pane bodies, so c3's session and artifact
 * panes consume it instead of each inventing their own.
 */
export function RunPaneChrome({ slot, title, subtitle, actions, children }: RunPaneChromeProps) {
  return (
    <section
      className={`or-run-workspace__pane or-run-workspace__pane--${slot}`}
      aria-label={`${title} pane`}
      data-testid={`or-run-pane-${slot}`}
    >
      <header className="or-run-workspace__pane-header">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="m-0 truncate text-sm font-semibold text-[var(--text-secondary)]">{title}</h3>
          {subtitle !== null && (
            <code className="truncate rounded bg-[var(--bg-code)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-muted)]">
              {subtitle}
            </code>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {actions.onOpenInOtherPane !== null && (
            <button
              type="button"
              className="or-run-workspace__pane-action"
              onClick={actions.onOpenInOtherPane}
              data-testid={`or-run-pane-move-${slot}`}
            >
              {slot === "primary" ? "Send right →" : "← Send left"}
            </button>
          )}
          <button
            type="button"
            className="or-run-workspace__pane-action"
            onClick={actions.onClose}
            aria-label={`Close ${title} pane`}
            data-testid={`or-run-pane-close-${slot}`}
          >
            ✕
          </button>
        </div>
      </header>
      <div className="or-run-workspace__pane-body">{children}</div>
    </section>
  );
}
