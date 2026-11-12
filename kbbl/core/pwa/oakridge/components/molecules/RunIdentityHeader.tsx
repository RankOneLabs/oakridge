import { Chip } from "../../../components/atoms/Chip";
import { selectStatusTone } from "../../lib/status-tone";
import { Button } from "../../../components/atoms/Button";
import type { RunDetail } from "../../run-types";
import type { RunAccentClass } from "../../lib/run-accent";
import { StatusBadge } from "../atoms/StatusBadge";

interface RunIdentityHeaderProps {
  run: RunDetail;
  /** One of the eight enumerated palette classes; never a computed colour. */
  accentClass: RunAccentClass;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  onBack: () => void;
}

/**
 * Who this run is: its title, its status, whether anything is parked on it, and
 * the accent that makes it recognisable at a glance across tabs.
 *
 * Presentational — every value is a prop. The sidebar toggle lives here rather
 * than in the sidebar because a collapsed sidebar has no visible surface left
 * to host its own control.
 */
export function RunIdentityHeader({
  run,
  accentClass,
  isSidebarOpen,
  onToggleSidebar,
  onBack,
}: RunIdentityHeaderProps) {
  return (
    <header className={`or-run-identity ${accentClass}`} data-testid="or-run-identity">
      <Button variant="secondary"
        type="button"
        className="or-run-identity__sidebar-toggle"
        onClick={onToggleSidebar}
        aria-expanded={isSidebarOpen}
        aria-label={isSidebarOpen ? "Hide run sidebar" : "Show run sidebar"}
        data-testid="or-sidebar-toggle"
      >
        ☰
      </Button>
      <Button variant="secondary" type="button" className="or-shell__back" onClick={onBack}>
        ← Runs
      </Button>
      <span className="or-run-identity__accent" aria-hidden="true" />
      <div className="or-run-identity__names">
        <h2
          className="m-0 text-lg font-semibold text-[var(--text-primary)]"
          data-testid="or-run-identity-title"
        >
          {run.title ?? run.workflow_name}
        </h2>
        <span className="text-xs text-[var(--text-muted)]" data-testid="or-run-identity-workflow">
          {run.workflow_name}
        </span>
        {run.repository_keys.length > 0 && (
          <span className="text-xs text-[var(--text-secondary)]" data-testid="or-run-identity-repositories">
            {run.repository_keys.join(" · ")}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={run.status} testId="or-run-identity-status" />
        {run.is_stuck && (
          <Chip tone={selectStatusTone("stuck")} testId="or-run-identity-stuck">
            stuck
          </Chip>
        )}
        {run.parked_count > 0 && (
          <Chip tone={selectStatusTone("parked")} testId="or-run-identity-parked">
            {run.parked_count} parked
          </Chip>
        )}
      </div>
    </header>
  );
}
