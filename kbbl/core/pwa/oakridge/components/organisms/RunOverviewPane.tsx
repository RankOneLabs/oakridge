import { Button } from "../../../components/atoms/Button";
import type { ArtifactId, Sid } from "../../../lib/ids";
import type { RunOverview } from "../../lib/run-overview";
import type { RunWorkspacePane } from "../../lib/run-workspace";
import type { RunActivityRead } from "../../lib/run-activity";
import { StatusBadge } from "../atoms/StatusBadge";

interface RunOverviewPaneProps {
  overview: RunOverview;
  activity: RunActivityRead;
  onOpenPane: (pane: RunWorkspacePane) => void;
}

const rowButtonClass = "w-full justify-start! border-[var(--border-subtle)]! py-2! text-left";
const attemptLabel = (attempt: { attempt_number: number; attempt_count: number }): string =>
  attempt.attempt_count > 1
    ? `attempt ${attempt.attempt_number} of ${attempt.attempt_count}`
    : `attempt ${attempt.attempt_number}`;

/** Presentational only: every lifecycle and attention fact comes from the diagnosis read. */
export function RunOverviewPane({ overview, activity, onOpenPane }: RunOverviewPaneProps) {
  const openSession = (sessionId: Sid) => onOpenPane({ kind: "session", session_id: sessionId });
  const openArtifact = (artifactId: ArtifactId) => onOpenPane({ kind: "artifact", artifact_id: artifactId });
  const currentSession = overview.current_session;

  return (
    <div className="flex flex-col gap-5" data-testid="or-run-overview">
      <section className="flex flex-wrap items-center gap-2">
        <StatusBadge status={overview.run.status} testId="or-overview-status" />
        {overview.run.status === "blocked" && (
          <span className="text-xs text-[var(--amber-fg)]" data-testid="or-overview-blocked-reason">
            {overview.run.blocked_reason} · next: {overview.run.next_actor}
          </span>
        )}
        <span className="text-xs text-[var(--text-muted)]" data-testid="or-overview-progress">
          {overview.stage_progress.complete} of {overview.stage_progress.total} stages complete
          {overview.stage_progress.blocked > 0 && ` · ${overview.stage_progress.blocked} blocked`}
          {overview.stage_progress.failed > 0 && ` · ${overview.stage_progress.failed} failed`}
          {overview.stage_progress.cancelled > 0 && ` · ${overview.stage_progress.cancelled} cancelled`}
        </span>
      </section>

      <section>
        <h4 className="or-run-overview__heading">Current session</h4>
        {currentSession === null ? (
          <p className="or-run-overview__empty" data-testid="or-overview-no-current-session">Nothing is executing.</p>
        ) : (
          <Button variant="secondary" type="button" className={rowButtonClass}
            onClick={() => openSession(currentSession.session_id as Sid)} data-testid="or-overview-current-session">
            {currentSession.stage_key} · {currentSession.cohort_id} · {attemptLabel(currentSession)}
          </Button>
        )}
      </section>

      <section>
        <h4 className="or-run-overview__heading">Awaiting you</h4>
        {overview.sessions_awaiting_action.length === 0 ? (
          <p className="or-run-overview__empty" data-testid="or-overview-no-awaiting">Nothing is waiting on a decision.</p>
        ) : (
          <ul className="or-run-overview__list">
            {overview.sessions_awaiting_action.map((session) => (
              <li key={session.session_id}>
                <Button variant="secondary" type="button" className={rowButtonClass}
                  onClick={() => openSession(session.session_id as Sid)} data-testid="or-overview-awaiting-session">
                  {session.stage_key} · {session.cohort_id} · {attemptLabel(session)}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="or-run-overview__heading">Open gates</h4>
        {overview.active_gates.length === 0 ? (
          <p className="or-run-overview__empty" data-testid="or-overview-no-gates">No gate is open.</p>
        ) : (
          <ul className="or-run-overview__list">
            {overview.active_gates.map((gate) => (
              <li key={gate.id} className="text-sm text-[var(--text-secondary)]" data-testid="or-overview-gate">
                {gate.stage_name} · {gate.gate_type} · {gate.resume_actions.join(" / ")}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="or-run-overview__heading">Activity</h4>
        {activity.kind === "pending" ? <p className="or-run-overview__empty">Loading activity…</p>
          : activity.kind === "unavailable" ? <p className="m-0 text-sm text-[var(--amber-fg)]" role="status">Run activity is unavailable.</p>
          : activity.items.length === 0 ? <p className="or-run-overview__empty" data-testid="or-overview-no-activity">No activity recorded yet.</p>
          : <ol className="or-run-overview__list" data-testid="or-run-activity">{activity.items.map((item) => (
            <li key={item.sequence} className="rounded-md border border-[var(--border-subtle)] px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2"><span>{item.summary}</span>{item.is_optional_attention && <span data-testid="or-activity-optional-attention">optional attention</span>}</div>
              {item.context !== null && <div className="text-xs text-[var(--text-muted)]">{item.context}</div>}
              {item.pull_request_url !== null && <a href={item.pull_request_url} target="_blank" rel="noreferrer">Open pull request</a>}
            </li>
          ))}</ol>}
      </section>

      <section>
        <h4 className="or-run-overview__heading">Recent releases</h4>
        {overview.recent_artifacts.length === 0 ? (
          <p className="or-run-overview__empty" data-testid="or-overview-no-releases">No artifact has been released yet.</p>
        ) : (
          <ul className="or-run-overview__list">{overview.recent_artifacts.map((artifact) => (
            <li key={artifact.artifact_id}><Button variant="secondary" type="button" className={rowButtonClass}
              onClick={() => openArtifact(artifact.artifact_id as ArtifactId)} data-testid="or-overview-release">
              {artifact.type_id} v{artifact.revision} · {artifact.stage_name}{artifact.label !== null && ` · ${artifact.label}`}
            </Button></li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}
