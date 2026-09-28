import { Button } from "../../../components/atoms/Button";
import type { ArtifactId, Sid } from "../../../lib/ids";
import type { RunOverview, RunOverviewGates } from "../../lib/run-overview";
import type { RunWorkspacePane } from "../../lib/run-workspace";
import type { RunActivityRead } from "../../lib/run-activity";
import { StatusBadge } from "../atoms/StatusBadge";

interface RunOverviewPaneProps {
  overview: RunOverview;
  activity: RunActivityRead;
  onOpenPane: (pane: RunWorkspacePane) => void;
}

const rowButtonClass =
  "w-full rounded-md border border-[var(--border-subtle)] px-3 py-2 text-left text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)]";

/**
 * Where the run stands, rendered from `selectRunOverview` output. It reads
 * nothing itself — every value is derived by the selector and handed down, so
 * this file stays markup and the derivations stay unit-tested.
 */
export function RunOverviewPane({ overview, activity, onOpenPane }: RunOverviewPaneProps) {
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
        {!overview.is_session_list_known ? (
          <SessionsNotice testId="or-overview-current-session-unavailable">
            Session list is unavailable — this is not showing what is executing.
          </SessionsNotice>
        ) : currentSession === null ? (
          <p className="or-run-overview__empty" data-testid="or-overview-no-current-session">
            Nothing is executing.
          </p>
        ) : (
          <Button variant="secondary"
            type="button"
            className={rowButtonClass}
            onClick={() => openSession(currentSession.session_id)}
            data-testid="or-overview-current-session"
          >
            {currentSession.stage_key} · {currentSession.unit_id} · {currentSession.attempt_label}
          </Button>
        )}
      </section>

      <section>
        <h4 className="or-run-overview__heading">Awaiting you</h4>
        <AwaitingYou
          gates={overview.gates}
          isSessionListKnown={overview.is_session_list_known}
          onOpenSession={openSession}
        />
      </section>

      <section>
        <h4 className="or-run-overview__heading">Active gates</h4>
        <ActiveGates gates={overview.gates} />
      </section>

      <section>
        <h4 className="or-run-overview__heading">Activity</h4>
        {activity.kind === "pending" ? (
          <p className="or-run-overview__empty">Loading activity…</p>
        ) : activity.kind === "unavailable" ? (
          <p className="m-0 text-sm text-[var(--amber-fg)]" role="status">
            Run activity is unavailable.
          </p>
        ) : activity.items.length === 0 ? (
          <p className="or-run-overview__empty" data-testid="or-overview-no-activity">
            No activity recorded yet.
          </p>
        ) : (
          <ol className="or-run-overview__list" data-testid="or-run-activity">
            {activity.items.map((item) => (
              <li key={item.sequence} className="rounded-md border border-[var(--border-subtle)] px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[var(--text-primary)]">{item.summary}</span>
                  {item.is_optional_attention && (
                    <span className="rounded border border-[var(--accent-blue)] px-1.5 py-0.5 text-xs text-[var(--accent-blue)]" data-testid="or-activity-optional-attention">
                      optional attention
                    </span>
                  )}
                </div>
                {item.context !== null && <div className="text-xs text-[var(--text-muted)]">{item.context}</div>}
                {item.pull_request_url !== null && (
                  <a className="text-xs text-[var(--accent-blue)] underline" href={item.pull_request_url} target="_blank" rel="noreferrer">
                    Open pull request
                  </a>
                )}
              </li>
            ))}
          </ol>
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
                <Button variant="secondary"
                  type="button"
                  className={rowButtonClass}
                  onClick={() => openArtifact(release.artifact_id)}
                  data-testid="or-overview-release"
                >
                  {release.type_id} v{release.version} · {release.stage_name}
                  {release.label !== null && ` · ${release.label}`}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface GatesNoticeProps {
  gates: Exclude<RunOverviewGates, { kind: "known" }>;
  /** Each section names its own notice, so an outage does not duplicate a test id. */
  testIdPrefix: string;
}

/**
 * What a gate-derived section says when there is no gate list behind it.
 *
 * The unavailable copy names the consequence rather than the failure: an
 * operator who reads "no gate is open" stops looking, so the one thing this has
 * to say is that the section is not answering the question right now.
 */
function GatesNotice({ gates, testIdPrefix }: GatesNoticeProps) {
  if (gates.kind === "pending") {
    return (
      <p className="or-run-overview__empty" data-testid={`${testIdPrefix}-pending`}>
        Checking…
      </p>
    );
  }
  return (
    <p className="m-0 text-sm text-[var(--amber-fg)]" role="status" data-testid={`${testIdPrefix}-unavailable`}>
      Gate status is unavailable — this section is not showing what needs you.
    </p>
  );
}

interface SessionsNoticeProps {
  testId: string;
  children: string;
}

/**
 * What a session-derived section says when the attempt list did not land.
 *
 * Same shape and same reasoning as `GatesNotice`: an empty attempt list reads as
 * a quiet run, and a quiet run is the one thing an outage must not be able to
 * claim. Separate from `GatesNotice` because the two reads fail independently —
 * gates can be fine while sessions are not, and naming the wrong one sends the
 * operator to check the wrong thing.
 */
function SessionsNotice({ testId, children }: SessionsNoticeProps) {
  return (
    <p
      className="m-0 text-sm text-[var(--amber-fg)]"
      role="status"
      data-testid={testId}
    >
      {children}
    </p>
  );
}

interface AwaitingYouProps {
  gates: RunOverviewGates;
  /** Whether the attempt list landed. Without it, no session can be named here. */
  isSessionListKnown: boolean;
  onOpenSession: (sessionId: Sid) => void;
}

/**
 * The sessions waiting on a decision — which needs *both* reads, since it is the
 * intersection of the open gates and the run's current attempts. The gate read
 * is reported first because a missing gate list makes the question unanswerable
 * outright, where a missing attempt list only costs the rows their identity.
 */
function AwaitingYou({ gates, isSessionListKnown, onOpenSession }: AwaitingYouProps) {
  if (gates.kind !== "known") return <GatesNotice gates={gates} testIdPrefix="or-overview-awaiting" />;
  if (!isSessionListKnown) {
    return (
      <SessionsNotice testId="or-overview-awaiting-sessions-unavailable">
        Session list is unavailable — this section is not showing what needs you.
      </SessionsNotice>
    );
  }
  if (gates.sessions_awaiting_action.length === 0) {
    return (
      <p className="or-run-overview__empty" data-testid="or-overview-no-awaiting">
        Nothing is waiting on a decision.
      </p>
    );
  }
  return (
    <ul className="or-run-overview__list">
      {gates.sessions_awaiting_action.map((session) => (
        <li key={session.session_id}>
          <Button variant="secondary"
            type="button"
            className={rowButtonClass}
            onClick={() => onOpenSession(session.session_id)}
            data-testid="or-overview-awaiting-session"
          >
            {session.stage_key} · {session.unit_id} · {session.attempt_label}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ActiveGates({ gates }: { gates: RunOverviewGates }) {
  if (gates.kind !== "known") return <GatesNotice gates={gates} testIdPrefix="or-overview-gates" />;
  if (gates.active.length === 0) {
    return (
      <p className="or-run-overview__empty" data-testid="or-overview-no-gates">
        No gate is open.
      </p>
    );
  }
  return (
    <ul className="or-run-overview__list">
      {gates.active.map((gate) => (
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
  );
}
