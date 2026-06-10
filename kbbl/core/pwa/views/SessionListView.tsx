import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Sidebar, type SidebarSession } from "../sidebar/Sidebar";

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
import { usePendingReviews } from "../hooks/usePendingReviews";
import { useUrlPrefill } from "../hooks/useUrlPrefill";

interface StartSessionBody {
  resume_from?: string;
  workdir?: string;
  name?: string;
  runtime?: RuntimeId;
  model?: string;
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

  const { pendingPlans, pendingBriefs } = usePendingReviews();
  const prefill = useUrlPrefill();

  const pendingPlanCards = pendingPlans?.ok ? pendingPlans.value : [];
  const pendingBriefCards = pendingBriefs?.ok ? pendingBriefs.value : [];
  const dataErrors = [pendingPlans, pendingBriefs]
    .filter((r): r is { ok: false; error: Error } => r?.ok === false)
    .map((r) => r.error.message);

  const sorted = useMemo(() => sortSessions(sessions), [sessions]);

  const startMutation = useMutation({
    mutationFn: async (body: StartSessionBody): Promise<SessionSnapshot> => {
      const res = await fetch("/sessions/operator", {
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

  const sidebarSessions: SidebarSession[] = useMemo(
    () =>
      sorted.map((s) => ({
        sid: s.sid,
        name: s.name,
        // Worktree-backed sessions live under /tmp/.../worktrees/<branch>;
        // projectWorkdir holds the canonical repo path that matches the
        // project.repo_path the sidebar groups by. Fall back to workdir
        // for pre-Phase-1 sessions that don't carry projectWorkdir.
        workdir: s.projectWorkdir ?? s.workdir,
        status: s.status,
      })),
    [sorted],
  );

  return (
    <div className="app-list-shell">
      <Sidebar sessions={sidebarSessions} onSelectSession={onSelect} />
      <div className="app app-list">
      <header className="top-bar">
        <span className={`status status-${inboxStatus}`}>{inboxStatus}</span>
        <span className="event-count">
          {sorted.length} {sorted.length === 1 ? "session" : "sessions"}
        </span>
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
      {dataErrors.length > 0 && (
        <section style={{ padding: "8px 12px" }}>
          <div className="sidebar-error" role="alert">
            {dataErrors.join(" · ")}
          </div>
        </section>
      )}

      {pendingPlanCards.length > 0 && (
        <section style={{ padding: "8px 12px" }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              opacity: 0.7,
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Pending plans
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {pendingPlanCards.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => { window.location.hash = `plan/${p.id}`; }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "6px 10px",
                    borderRadius: 4,
                    border: "1px solid var(--border, #444)",
                    background: "var(--surface-raised, #1e1e1e)",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>Plan {p.id.slice(0, 8)}</span>
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      opacity: 0.5,
                    }}
                  >
                    {p.created_at.slice(0, 10)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pendingBriefCards.length > 0 && (
        <section style={{ padding: "8px 12px" }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              opacity: 0.7,
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Pending briefs
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {pendingBriefCards.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => { window.location.hash = `brief/${b.id}`; }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "6px 10px",
                    borderRadius: 4,
                    border: "1px solid var(--border, #444)",
                    background: "var(--surface-raised, #1e1e1e)",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>
                    {b.goal.length > 60 ? `${b.goal.slice(0, 60)}…` : b.goal}
                  </span>
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      opacity: 0.5,
                    }}
                  >
                    {b.created_at.slice(0, 10)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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
