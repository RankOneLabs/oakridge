import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";


import type {
  RuntimeDescriptor, SessionSnapshot, Status,
} from "../types";
import type { RuntimeId } from "../../runtime-interface";
import {
  compareSessionsByDisplayedActivity,
  groupSessionsByRun,
  selectNextJustNowExpiryDelay,
} from "../../acp/pwa-session-order";
import type { SessionRunGroup } from "../../acp/pwa-session-order";

import { SessionRow } from "../components/organisms/SessionRow";
import { FeedbackMessage } from "../components/atoms/FeedbackMessage";
import { SessionCohortHeading } from "../components/molecules/SessionCohortHeading";
import {
  NewSessionForm,
  type NewSessionFormValues,
} from "../components/organisms/NewSessionForm";
import { useUrlPrefill } from "../hooks/useUrlPrefill";
import { useRun } from "../oakridge/hooks/useRun";
import { useRuns } from "../oakridge/hooks/useRuns";
import {
  selectSessionRunTitle,
  selectSessionStageName,
} from "../lib/session";

interface StartSessionBody {
  resume_from?: string;
  workdir?: string;
  name?: string;
  runtime?: RuntimeId;
  model?: string;
  effort?: string;
}

interface SessionRowListProps {
  sessions: SessionSnapshot[];
  onSelect: (sid: string) => void;
  onResume: (sid: string) => void;
  resumeDisabled: boolean;
}

function SessionRowList({ sessions, onSelect, onResume, resumeDisabled }: SessionRowListProps) {
  return (
    <ul className="session-list">
      {sessions.map((s) => (
        <SessionRow
          key={s.sid}
          snapshot={s}
          onOpen={() => onSelect(s.sid)}
          onResume={() => onResume(s.sid)}
          resumeDisabled={resumeDisabled}
        />
      ))}
    </ul>
  );
}

interface SessionRunSectionProps {
  run: SessionRunGroup;
  title: string | null;
  onSelect: (sid: string) => void;
  onResume: (sid: string) => void;
  resumeDisabled: boolean;
}

function SessionRunSection({
  run,
  title,
  onSelect,
  onResume,
  resumeDisabled,
}: SessionRunSectionProps) {
  const hasStageGroup = run.groups.some((group) => group.kind === "stage");
  const runQuery = useRun(run.runId, hasStageGroup);

  return (
    <section
      className="session-run-group"
      data-testid={`session-run-${run.runId}`}
    >
      <h2 className="session-cohort-heading session-cohort-heading--plain">
        {title ?? "Run"}
      </h2>
      {run.groups.map((group) => (
        <section key={group.key} className="session-cohort-group">
          <SessionCohortHeading
            title={group.kind === "cohort"
              ? group.title
              : selectSessionStageName(group.stageInstanceId, runQuery.data) ?? "Stage"}
            secondaryId={group.kind === "cohort" ? group.unitId : undefined}
            repositoryKey={group.repositoryKey}
          />
          <SessionRowList
            sessions={group.sessions}
            onSelect={onSelect}
            onResume={onResume}
            resumeDisabled={resumeDisabled}
          />
        </section>
      ))}
    </section>
  );
}

interface SessionListViewProps {
  sessions: Map<string, SessionSnapshot>;
  inboxStatus: Status;
  defaultWorkdir: string | null;
  defaultRuntimeId: RuntimeId;
  runtimes: RuntimeDescriptor[];
  onSelect: (sid: string) => void;
  onHydrateSession: (snapshot: SessionSnapshot) => void;
}

export function SessionListView({
  sessions,
  inboxStatus,
  defaultWorkdir,
  defaultRuntimeId,
  runtimes,
  onSelect,
  onHydrateSession,
}: SessionListViewProps) {
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [orderingTick, setOrderingTick] = useState(0);

  useEffect(() => {
    const delay = selectNextJustNowExpiryDelay([...sessions.values()], Date.now());
    if (delay === null) return;
    const timeout = setTimeout(() => setOrderingTick((tick) => tick + 1), delay);
    return () => clearTimeout(timeout);
  }, [orderingTick, sessions]);

  const prefill = useUrlPrefill();

  const grouping = useMemo(
    () => groupSessionsByRun(
      [...sessions.values()],
      compareSessionsByDisplayedActivity(Date.now()),
    ),
    [orderingTick, sessions],
  );
  const runsQuery = useRuns("all", grouping.runs.length > 0);
  const totalCount = sessions.size;

  const startMutation = useMutation({
    mutationFn: async (body: StartSessionBody): Promise<SessionSnapshot> => {
      const res = await fetch("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const responseBody = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof responseBody?.error === "string"
            ? responseBody.error
            : `server returned ${res.status}`,
        );
      }
      return (await res.json()) as SessionSnapshot;
    },
  });

  // Shared POST /sessions path for both the "+ New session" form and
  // row-level Resume buttons. Resume passes resume_from and ignores
  // workdir (parent's workdir wins server-side); a fresh session requires
  // an explicit workdir from the form (prefilled with the server default,
  // but the operator has to consciously submit a value).
  async function startSession(
    values?: NewSessionFormValues,
    resumeFrom?: string,
  ) {
    if (startMutation.isPending) return;
    setPendingError(null);
    const body: StartSessionBody = {};
    if (resumeFrom) {
      body.resume_from = resumeFrom;
    } else if (values) {
      const trimmed = values.workdir.trim();
      if (!trimmed) {
        setPendingError("workdir is required");
        return;
      }
      body.workdir = trimmed;
      body.name = values.name;
      body.runtime = values.runtimeId;
      if (values.model !== "") body.model = values.model;
      if (values.effort !== "") body.effort = values.effort;
    } else {
      setPendingError("internal: startSession needs values or resumeFrom");
      return;
    }
    try {
      const snap = await startMutation.mutateAsync(body);
      // Hydrate before navigating so SessionView mounts with the snapshot
      // present and inMemory=true, rather than racing the /inbox
      // session_created delta. Without this the input box is hidden and
      // the stream falls back to one-shot /events for the first ~100ms.
      onHydrateSession(snap);
      onSelect(snap.sid);
      setResetSignal((n) => n + 1);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : "network error");
    }
  }

  return (
    <div className="app-list-shell">
      <div className="app app-list">
      <header className="top-bar">
        <div className="workspace-heading">
          <span className="workspace-eyebrow">Operator workspace</span>
          <strong>Sessions</strong>
        </div>
        <div className="workspace-status">
          <span className={`status status-${inboxStatus}`}>{inboxStatus}</span>
          <span className="event-count">
            {totalCount} {totalCount === 1 ? "session" : "sessions"}
          </span>
        </div>
      </header>
      <div className="session-list-intro">
        <div>
          <p className="section-kicker">Command center</p>
          <h1>Start, resume, and review your work.</h1>
          <p>Keep active agent sessions and pending decisions in one readable queue.</p>
        </div>
      </div>
      <div className="session-list-actions">
        <NewSessionForm
          defaultWorkdir={defaultWorkdir}
          defaultRuntimeId={defaultRuntimeId}
          runtimes={runtimes}
          initialWorkdir={prefill.initialWorkdir}
          workdirTouchedInitial={prefill.workdirTouchedInitial}
          pending={startMutation.isPending}
          autostartPending={prefill.autostartPending}
          onAutostartConsumed={() => prefill.setAutostartPending(false)}
          resetSignal={resetSignal}
          onSubmit={(values) => { void startSession(values); }}
        />
        {pendingError && <FeedbackMessage tone="danger" className="input-error">error: {pendingError}</FeedbackMessage>}
      </div>
      {totalCount === 0 ? (
        <FeedbackMessage tone="empty" className="session-list-empty">No sessions yet.</FeedbackMessage>
      ) : (
        <div className="session-cohort-groups">
          {grouping.runs.map((run) => (
            <SessionRunSection
              key={run.runId}
              run={run}
              title={selectSessionRunTitle(run.runId, runsQuery.data ?? [])}
              onSelect={onSelect}
              onResume={(sid) => void startSession(undefined, sid)}
              resumeDisabled={startMutation.isPending}
            />
          ))}
          {grouping.unattached.length > 0 && (
            <section
              className="session-cohort-group session-cohort-group--unattached"
              data-testid="unattached-sessions"
            >
              <h2 className="session-cohort-heading session-cohort-heading--plain">
                Unattached sessions
              </h2>
              <SessionRowList
                sessions={grouping.unattached}
                onSelect={onSelect}
                onResume={(sid) => void startSession(undefined, sid)}
                resumeDisabled={startMutation.isPending}
              />
            </section>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
