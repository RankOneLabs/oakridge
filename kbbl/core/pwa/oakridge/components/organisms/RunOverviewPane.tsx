import type { ArtifactId, Sid } from "../../../lib/ids";
import type { RunOverview } from "../../lib/run-overview";
import type { RunWorkspacePane } from "../../lib/run-workspace";
import { StatusBadge } from "../atoms/StatusBadge";

interface RunOverviewPaneProps {
  overview: RunOverview;
  onOpenPane: (pane: RunWorkspacePane) => void;
}

const rowButtonClass =
  "w-full rounded-md border border-[var(--border-subtle)] px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";

/**
 * Where the run stands, rendered from `selectRunOverview` output. It reads
 * nothing itself — every value is derived by the selector and handed down, so
 * this file stays markup and the derivations stay unit-tested.
 */
export function RunOverviewPane({ overview, onOpenPane }: RunOverviewPaneProps) {
  const openSession = (sessionId: Sid) => onOpenPane({ kind: "session", session_id: sessionId });
  const openArtifact = (artifactId: ArtifactId) =>
    onOpenPane({ kind: "artifact", artifact_id: artifactId });
  const currentSession = overview.current_session;

  return (
    <div className="flex flex-col gap-5" data-testid="or-run-overview">
      <section className="flex flex-wrap items-center gap-2">
        <StatusBadge status={overview.status} testId="or-overview-status" />
        {overview.is_stuck && <span className="text-xs text-red-500">stuck</span>}
        <span className="text-xs text-[var(--text-muted)]" data-testid="or-overview-progress">
          {overview.stage_progress.complete} of {overview.stage_progress.total} stages complete
          {overview.stage_progress.parked > 0 && ` · ${overview.stage_progress.parked} parked`}
          {overview.stage_progress.failed > 0 && ` · ${overview.stage_progress.failed} failed`}
        </span>
      </section>

      <section>
        <h4 className="or-run-overview__heading">Current session</h4>
        {currentSession === null ? (
          <p className="or-run-overview__empty" data-testid="or-overview-no-current-session">
            Nothing is executing.
          </p>
        ) : (
          <button
            type="button"
            className={rowButtonClass}
            onClick={() => openSession(currentSession.session_id)}
            data-testid="or-overview-current-session"
          >
            {currentSession.stage_key} · {currentSession.unit_id} · {currentSession.attempt_label}
          </button>
        )}
      </section>

      <section>
        <h4 className="or-run-overview__heading">Awaiting you</h4>
        {overview.sessions_awaiting_action.length === 0 ? (
          <p className="or-run-overview__empty" data-testid="or-overview-no-awaiting">
            Nothing is waiting on a decision.
          </p>
        ) : (
          <ul className="or-run-overview__list">
            {overview.sessions_awaiting_action.map((session) => (
              <li key={session.session_id}>
                <button
                  type="button"
                  className={rowButtonClass}
                  onClick={() => openSession(session.session_id)}
                  data-testid="or-overview-awaiting-session"
                >
                  {session.stage_key} · {session.unit_id} · {session.attempt_label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="or-run-overview__heading">Active gates</h4>
        {overview.active_gates.length === 0 ? (
          <p className="or-run-overview__empty" data-testid="or-overview-no-gates">
            No gate is open.
          </p>
        ) : (
          <ul className="or-run-overview__list">
            {overview.active_gates.map((gate) => (
              <li key={gate.gate_id} className="text-sm text-[var(--text-secondary)]" data-testid="or-overview-gate">
                {gate.stage_name} · {gate.unit_id} · {gate.gate_type}
                {gate.resume_actions.length > 0 && (
                  <span className="ml-2 text-xs text-[var(--text-muted)]">
                    {gate.resume_actions.join(" / ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="or-run-overview__heading">Recent releases</h4>
        {overview.recent_slot_releases.length === 0 ? (
          <p className="or-run-overview__empty" data-testid="or-overview-no-releases">
            No artifact has been released yet.
          </p>
        ) : (
          <ul className="or-run-overview__list">
            {overview.recent_slot_releases.map((release) => (
              <li key={release.artifact_id}>
                <button
                  type="button"
                  className={rowButtonClass}
                  onClick={() => openArtifact(release.artifact_id)}
                  data-testid="or-overview-release"
                >
                  {release.type_id} v{release.version} · {release.stage_name}
                  {release.label !== null && ` · ${release.label}`}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
