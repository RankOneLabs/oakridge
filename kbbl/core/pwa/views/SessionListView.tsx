import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";


import type {
  RuntimeDescriptor, SessionSnapshot, Theme, Status,
} from "../types";
import type { RuntimeId } from "../../runtime-interface";
import { sortSessions } from "../lib/session";

import { SessionRow } from "../components/organisms/SessionRow";
import {
  NewSessionForm,
  type NewSessionFormValues,
} from "../components/organisms/NewSessionForm";
import { useUrlPrefill } from "../hooks/useUrlPrefill";

interface StartSessionBody {
  resume_from?: string;
  workdir?: string;
  name?: string;
  runtime?: RuntimeId;
  model?: string;
  effort?: string;
}

interface SessionListViewProps {
  sessions: Map<string, SessionSnapshot>;
  inboxStatus: Status;
  theme: Theme;
  defaultWorkdir: string | null;
  defaultRuntimeId: RuntimeId;
  runtimes: RuntimeDescriptor[];
  onToggleTheme: () => void;
  onSelect: (sid: string) => void;
  onHydrateSession: (snapshot: SessionSnapshot) => void;
}

export function SessionListView({
  sessions,
  inboxStatus,
  theme,
  defaultWorkdir,
  defaultRuntimeId,
  runtimes,
  onToggleTheme,
  onSelect,
  onHydrateSession,
}: SessionListViewProps) {
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  const prefill = useUrlPrefill();

  const sorted = useMemo(() => sortSessions(sessions), [sessions]);

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
            {sorted.length} {sorted.length === 1 ? "session" : "sessions"}
          </span>
        </div>
        <button
          type="button"
          className="workspace-nav-link"
          onClick={() => { window.location.hash = "oakridge"; }}
        >
          <span>Oakridge</span>
          <small>Workflows</small>
        </button>
        <button
          type="button"
          className="theme-toggle"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
        >
          {theme === "dark" ? "LIGHT" : "DARK"}
        </button>
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
          pendingError={pendingError}
          autostartPending={prefill.autostartPending}
          onAutostartConsumed={() => prefill.setAutostartPending(false)}
          resetSignal={resetSignal}
          onSubmit={(values) => { void startSession(values); }}
        />
      </div>
      {sorted.length === 0 ? (
        <div className="session-list-empty">No sessions yet.</div>
      ) : (
        <ul className="session-list">
          {sorted.map((s) => (
            <SessionRow
              key={s.sid}
              snapshot={s}
              onOpen={() => onSelect(s.sid)}
              onResume={() => void startSession(undefined, s.sid)}
              resumeDisabled={startMutation.isPending}
            />
          ))}
        </ul>
      )}
      </div>
    </div>
  );
}
