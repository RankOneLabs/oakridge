import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import type { Task, PermissionProfile } from "../safir/types";
import { PlanReviewView } from "./review/plan/PlanReviewView";
import { BriefReviewView } from "./review/brief/BriefReviewView";
import { Sidebar, type SidebarSession } from "./sidebar/Sidebar";

import type {
  EnvelopeEvent, SessionStatus, SessionSnapshot, Theme, ResolutionMap,
  PendingPlanCard, PendingBriefCard, CompactSuggestion, Status,
  InFlightAssistant, PendingMessage, SafirTask, SafirHandoff, TaskFetchState,
  CCUserPayload, CCAssistantPayload, ContentBlock, PermissionRequestPayload,
  ToolUseEntry, ToolResultEntry, SystemStatusPayload,
} from "./types";
import { useHashSid } from "./hooks/useHashSid";
import { useHashTaskId } from "./hooks/useHashTaskId";
import { useHashRoute } from "./hooks/useHashRoute";
import { useServerConfig } from "./hooks/useServerConfig";
import { useTheme } from "./hooks/useTheme";
import { useInbox } from "./hooks/useInbox";
import { useRelativeTime } from "./hooks/useRelativeTime";
import { useInFlightAssistant, turnStartedAtMs } from "./hooks/useInFlightAssistant";
import { useElapsedSeconds } from "./hooks/useElapsedSeconds";
import { generateSlug, sortSessions, toPositiveSafeInt, sessionLabelTitle, workdirBasename, resumeTitle } from "./lib/session";
import { prettyModelLabel, PWA_MODEL_OPTIONS, fmtTokensCompact, fmtDuration, fmtCost } from "./lib/format";
import { formatExactTime, parseIsoMs, formatElapsedSeconds } from "./lib/time";
import { lastMessageEventId, computeMetrics, buildListItems, summarizeToolNames, previewToolInput, isLowSignalEvent, parseSlashCommand, parseLocalCommandStdout, formatResultText } from "./lib/events";
import { NEW_SESSION_MODEL_STORAGE_KEY, readStoredNewSessionModel } from "./lib/storage";

async function resumeSession(
  parentSid: string,
  hydrate: (snap: SessionSnapshot) => void,
  navigate: (sid: string) => void,
): Promise<string | null> {
  const res = await fetch("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume_from: parentSid }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return typeof body?.error === "string"
      ? body.error
      : `server returned ${res.status}`;
  }
  const snap = (await res.json()) as SessionSnapshot;
  hydrate(snap);
  navigate(snap.sid);
  return null;
}

export function App() {
  const route = useHashRoute();
  const [sid, navigate] = useHashSid();
  const [taskId, navigateTask] = useHashTaskId();
  const [theme, toggleTheme] = useTheme();
  const { sessions, inMemorySids, inboxStatus, compactSuggestions, clearCompactSuggestion, hydrateSession } = useInbox({
    // When the active session is purged from another client / tab, drop
    // back to the inbox list so SessionView isn't left rendering a stale
    // transcript with no underlying session record. Comparing inside the
    // callback (not via deps) is fine because the ref dance in useInbox
    // ensures we always see the latest sid closure.
    onSessionRemoved: (removedSid) => {
      if (removedSid === sid) navigate(null);
    },
  });
  const config = useServerConfig();
  const [softThresholdTokens, setSoftThresholdTokens] = useState<number>(50000);
  const [thresholdInput, setThresholdInput] = useState<string>("50000");

  useEffect(() => {
    if (typeof config?.softThresholdTokens === "number") {
      setSoftThresholdTokens(config.softThresholdTokens);
      setThresholdInput(String(config.softThresholdTokens));
    }
  }, [config?.softThresholdTokens]);

  // Hash routing precedence: plan/brief views win over session/task views.
  // These use path-style hashes (#plan/<id>, #brief/<id>) which don't
  // collide with the query-param style #sid=X and #task=X routes.
  if (route?.view === "plan") {
    return (
      <PlanReviewView
        id={route.id}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={() => { window.location.hash = ""; }}
      />
    );
  }
  if (route?.view === "brief") {
    return (
      <BriefReviewView
        id={route.id}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={() => { window.location.hash = ""; }}
      />
    );
  }

  // Precedence: #sid wins over #task. The hash writers always overwrite
  // the entire fragment, so both being set simultaneously is unreachable
  // by normal navigation; this branch is a defensive ordering only.
  if (sid !== null) {
    return (
      <SessionView
        sid={sid}
        snapshot={sessions.get(sid) ?? null}
        inMemory={inMemorySids.has(sid)}
        inboxStatus={inboxStatus}
        theme={theme}
        compactSuggestion={compactSuggestions.get(sid) ?? null}
        onClearCompactSuggestion={() => clearCompactSuggestion(sid)}
        softThresholdTokens={softThresholdTokens}
        thresholdInput={thresholdInput}
        onSoftThresholdChange={(n, input) => {
          setSoftThresholdTokens(n);
          setThresholdInput(input);
        }}
        onToggleTheme={toggleTheme}
        onBack={() => navigate(null)}
        onResume={(parentSid) => resumeSession(parentSid, hydrateSession, navigate)}
      />
    );
  }
  if (taskId !== null) {
    return (
      <TaskView
        taskId={taskId}
        theme={theme}
        safirWebUrl={config?.safirWebUrl ?? "http://localhost:3000"}
        onToggleTheme={toggleTheme}
        onBack={() => navigateTask(null)}
      />
    );
  }
  return (
    <SessionListView
      sessions={sessions}
      inboxStatus={inboxStatus}
      theme={theme}
      defaultWorkdir={config?.defaultWorkdir ?? ""}
      onToggleTheme={toggleTheme}
      onSelect={(nextSid) => navigate(nextSid)}
      onHydrateSession={hydrateSession}
    />
  );
}

// === session list ===

function SessionListView({
  sessions,
  inboxStatus,
  theme,
  defaultWorkdir,
  onToggleTheme,
  onSelect,
  onHydrateSession,
}: {
  sessions: Map<string, SessionSnapshot>;
  inboxStatus: Status;
  theme: Theme;
  defaultWorkdir: string;
  onToggleTheme: () => void;
  onSelect: (sid: string) => void;
  onHydrateSession: (snapshot: SessionSnapshot) => void;
}) {
  const [pending, setPending] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [workdirInput, setWorkdirInput] = useState("");
  const [workdirTouched, setWorkdirTouched] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [modelInput, setModelInput] = useState<string>(readStoredNewSessionModel);
  // Generated once per mount so the placeholder is stable while the operator
  // is filling out the form (otherwise it would flicker on every re-render).
  // Submit uses the current placeholder if name field is empty, so what they
  // see is what they get.
  const [namePlaceholder, setNamePlaceholder] = useState(generateSlug);
  const [taskInput, setTaskInput] = useState("");
  const [profileInput, setProfileInput] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [profiles, setProfiles] = useState<PermissionProfile[]>([]);
  const [autostartPending, setAutostartPending] = useState(false);
  const profileLockedRef = useRef(false);
  const sorted = useMemo(() => sortSessions(sessions), [sessions]);

  // Pending review items for the operator inbox sections at the top.
  const [pendingPlans, setPendingPlans] = useState<PendingPlanCard[]>([]);
  const [pendingBriefs, setPendingBriefs] = useState<PendingBriefCard[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fetchPending = async () => {
      try {
        const [plansRes, briefsRes] = await Promise.all([
          fetch("/plans?status=pending_approval"),
          fetch("/briefs?status=pending_approval"),
        ]);
        if (cancelled) return;
        if (plansRes.ok) {
          const plans = (await plansRes.json()) as PendingPlanCard[];
          if (!cancelled) setPendingPlans(plans);
        }
        if (briefsRes.ok) {
          const briefs = (await briefsRes.json()) as PendingBriefCard[];
          if (!cancelled) setPendingBriefs(briefs);
        }
      } catch {
        // network error; sections stay hidden
      }
    };
    void fetchPending();
    return () => { cancelled = true; };
  }, []);

  // Prefill the workdir input with the server default once /config resolves,
  // but only if the operator hasn't typed anything yet — otherwise a slow
  // /config response would clobber what they were mid-typing. workdirTouched
  // also prevents re-prefilling after the operator deliberately cleared it.
  useEffect(() => {
    if (workdirTouched) return;
    if (defaultWorkdir && workdirInput === "") {
      setWorkdirInput(defaultWorkdir);
    }
  }, [defaultWorkdir, workdirInput, workdirTouched]);

  useEffect(() => {
    try {
      localStorage.setItem(NEW_SESSION_MODEL_STORAGE_KEY, modelInput);
    } catch {}
  }, [modelInput]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/safir/tasks");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Task[];
        if (cancelled) return;
        setTasks(data.filter((t) => t.status === "active" || t.status === "backlog"));
      } catch {}
    })();
    void (async () => {
      try {
        const res = await fetch("/safir/permission-profiles");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as PermissionProfile[];
        if (cancelled) return;
        setProfiles(data);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.size === 0) return;
    const wd = params.get("workdir");
    const tid = toPositiveSafeInt(params.get("task_id"));
    const pid = toPositiveSafeInt(params.get("profile_id"));
    const auto = params.get("autostart") === "true";
    if (wd) {
      setWorkdirInput(wd);
      setWorkdirTouched(true);
    }
    if (tid !== null) setTaskInput(String(tid));
    if (pid !== null) {
      setProfileInput(String(pid));
      profileLockedRef.current = true;
    }
    if (auto) setAutostartPending(true);
    history.replaceState(null, "", window.location.pathname + window.location.hash);
  }, []);

  useEffect(() => {
    if (profileLockedRef.current) return;
    if (taskInput === "") {
      setProfileInput("");
      return;
    }
    const task = tasks.find((t) => String(t.id) === taskInput);
    if (!task) return;
    setProfileInput(
      task.default_permission_profile_id != null
        ? String(task.default_permission_profile_id)
        : ""
    );
  }, [taskInput, tasks]);

  // Shared POST /sessions path for both the "+ New session" button and
  // row-level Resume buttons. Resume passes resume_from and ignores
  // workdir (parent's workdir wins server-side); a fresh session requires
  // an explicit workdir from the input box (prefilled with the server
  // default, but the operator has to consciously submit a value).
  async function startSession(resumeFrom?: string) {
    if (pending) return;
    setPendingError(null);
    const body: {
      resume_from?: string;
      workdir?: string;
      name?: string;
      model?: string;
      task_id?: number;
      permission_profile_id?: number;
    } = {};
    if (resumeFrom) {
      body.resume_from = resumeFrom;
    } else {
      const trimmed = workdirInput.trim();
      if (!trimmed) {
        setPendingError("workdir is required");
        return;
      }
      body.workdir = trimmed;
      const nameTrim = nameInput.trim();
      body.name = nameTrim || namePlaceholder;
      if (modelInput !== "") body.model = modelInput;
      const parsedTaskId = toPositiveSafeInt(taskInput || null);
      if (parsedTaskId !== null) body.task_id = parsedTaskId;
      const parsedProfileId = toPositiveSafeInt(profileInput || null);
      if (parsedProfileId !== null) body.permission_profile_id = parsedProfileId;
    }
    setPending(true);
    try {
      const res = await fetch("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const responseBody = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setPendingError(
          typeof responseBody?.error === "string"
            ? responseBody.error
            : `server returned ${res.status}`,
        );
        return;
      }
      const snap = (await res.json()) as SessionSnapshot;
      // Hydrate before navigating so SessionView mounts with the snapshot
      // present and inMemory=true, rather than racing the /inbox
      // session_created delta. Without this the input box is hidden and
      // the stream falls back to one-shot /events for the first ~100ms.
      onHydrateSession(snap);
      onSelect(snap.sid);
      // Reset name field + reroll slug so a follow-up "+ New" gets a fresh
      // suggestion, not a recycled one.
      setNameInput("");
      setNamePlaceholder(generateSlug());
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : "network error");
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    if (!autostartPending) return;
    if (workdirInput.trim() === "") return;
    setAutostartPending(false);
    const timer = setTimeout(() => { void startSession(); }, 100);
    return () => clearTimeout(timer);
  }, [autostartPending, workdirInput]); // startSession captured at render time is intentional

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
        <form
          className="new-session-form"
          onSubmit={(e) => {
            e.preventDefault();
            void startSession();
          }}
        >
          <input
            type="text"
            className="new-session-workdir"
            placeholder="/absolute/path/to/workdir"
            value={workdirInput}
            onChange={(e) => {
              setWorkdirInput(e.target.value);
              setWorkdirTouched(true);
            }}
            disabled={pending}
            required
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Workdir for new session"
          />
          <select
            className="new-session-task"
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value)}
            disabled={pending}
            aria-label="Bind session to safir task (optional)"
          >
            <option value="">no task (free session)</option>
            {tasks.map((t) => (
              <option key={t.id} value={String(t.id)}>
                #{t.id} {t.title}
              </option>
            ))}
          </select>
          <select
            className="new-session-profile"
            value={profileInput}
            onChange={(e) => {
              setProfileInput(e.target.value);
              profileLockedRef.current = true;
            }}
            disabled={pending}
            aria-label="Permission profile (optional)"
          >
            <option value="">use built-in default</option>
            {profiles.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
                {p.is_seed ? " (seed)" : ""}
              </option>
            ))}
          </select>
          <select
            className="new-session-model"
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            disabled={pending}
            aria-label="Model for new session"
          >
            {PWA_MODEL_OPTIONS.map((opt) => (
              <option key={opt.value || "default"} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            className="new-session-name"
            placeholder={namePlaceholder}
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            disabled={pending}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            maxLength={80}
            aria-label="Optional session name"
            title="Leave blank to use the generated name shown as placeholder"
          />
          <button
            type="submit"
            className="btn-new-session"
            disabled={pending || workdirInput.trim() === ""}
          >
            {pending ? "starting…" : "+ New"}
          </button>
        </form>
        {pendingError && (
          <div className="input-error" role="alert">
            error: {pendingError}
          </div>
        )}
      </div>
      {pendingPlans.length > 0 && (
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
            {pendingPlans.map((p) => (
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

      {pendingBriefs.length > 0 && (
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
            {pendingBriefs.map((b) => (
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
              onResume={() => void startSession(s.sid)}
              resumeDisabled={pending}
            />
          ))}
        </ul>
      )}
      </div>
    </div>
  );
}


function SessionRow({
  snapshot,
  onOpen,
  onResume,
  resumeDisabled,
}: {
  snapshot: SessionSnapshot;
  onOpen: () => void;
  onResume: () => void;
  resumeDisabled: boolean;
}) {
  const relative = useRelativeTime(snapshot.lastActivityTs);
  const canResume = snapshot.status === "ended";
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Auto-clear the confirm-pending state after a few seconds so a stray
  // first tap doesn't leave a primed Remove button waiting indefinitely.
  useEffect(() => {
    if (!confirmRemove) return;
    const t = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(t);
  }, [confirmRemove]);

  async function remove() {
    if (removing) return;
    setRemoving(true);
    try {
      await fetch(`/sessions/${encodeURIComponent(snapshot.sid)}?purge=true`, {
        method: "DELETE",
      });
      // Server broadcasts session_removed; the inbox handler drops the row.
      // No optimistic UI here — if the request failed silently the row
      // simply stays put and the operator can retry.
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  return (
    <li className="session-row-li">
      <button
        type="button"
        className={`session-row session-row-${snapshot.status}`}
        onClick={onOpen}
      >
        <div className="session-row-line">
          <span className={`session-row-status session-row-status-${snapshot.status}`}>
            {snapshot.status === "compacting" ? "compacting…" : snapshot.status}
          </span>
          <span className="session-row-name" title={snapshot.sid}>
            {snapshot.name || snapshot.sid.slice(0, 8)}
          </span>
          {snapshot.model && (
            <span className="session-row-model" title={snapshot.model}>
              {prettyModelLabel(snapshot.model)}
            </span>
          )}
          {snapshot.pendingCount > 0 && (
            <span className="session-row-pending" aria-label={`${snapshot.pendingCount} pending approvals`}>
              {snapshot.pendingCount} pending
            </span>
          )}
          {snapshot.yoloMode && (
            <span className="session-row-yolo">YOLO</span>
          )}
          <span className="session-row-activity">{relative}</span>
        </div>
        <div className="session-row-workdir" title={snapshot.workdir}>
          {snapshot.workdir}
        </div>
        {snapshot.endReason === "compacted" && snapshot.successorSid && (
          <div
            className="session-row-successor"
            title={`Continued in successor session ${snapshot.successorSid}`}
          >
            → {snapshot.successorSid.slice(0, 8)}
          </div>
        )}
      </button>
      {canResume && (
        <button
          type="button"
          className="btn-resume"
          disabled={resumeDisabled}
          title={resumeTitle(snapshot.lastResultUsage)}
          onClick={(e) => {
            // Don't also trigger the row's open-transcript click behind us.
            e.stopPropagation();
            onResume();
          }}
        >
          Resume
        </button>
      )}
      <button
        type="button"
        className={`btn-remove${confirmRemove ? " is-confirming" : ""}`}
        disabled={removing}
        title={
          snapshot.status === "live"
            ? "Aborts the live subprocess and deletes the transcript file."
            : "Deletes the transcript file."
        }
        onClick={(e) => {
          e.stopPropagation();
          if (!confirmRemove) {
            setConfirmRemove(true);
            return;
          }
          void remove();
        }}
      >
        {removing
          ? "removing…"
          : confirmRemove
            ? "tap to confirm"
            : "Remove"}
      </button>
    </li>
  );
}



function MessageTimestamp({ iso }: { iso: string }) {
  const rel = useRelativeTime(iso);
  if (!rel) return null;
  return (
    <span className="bubble-ts" title={formatExactTime(iso)}>
      {rel}
    </span>
  );
}




// === session view ===


function SessionView({
  sid,
  snapshot,
  inMemory,
  inboxStatus,
  theme,
  compactSuggestion,
  onClearCompactSuggestion,
  softThresholdTokens,
  thresholdInput,
  onSoftThresholdChange,
  onToggleTheme,
  onBack,
  onResume,
}: {
  sid: string;
  snapshot: SessionSnapshot | null;
  inMemory: boolean;
  inboxStatus: Status;
  theme: Theme;
  compactSuggestion: CompactSuggestion | null;
  onClearCompactSuggestion: () => void;
  softThresholdTokens: number;
  thresholdInput: string;
  onSoftThresholdChange: (n: number, input: string) => void;
  onToggleTheme: () => void;
  onBack: () => void;
  onResume: (parentSid: string) => Promise<string | null>;
}) {
  const [events, setEvents] = useState<EnvelopeEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<Status>("connecting");
  const [resolutions, setResolutions] = useState<ResolutionMap>(
    () => new Map(),
  );
  const [yoloMode, setYoloMode] = useState(false);
  const [allowedTools, setAllowedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [showSystemEvents, setShowSystemEvents] = useState(false);
  const seenIds = useRef<Set<number>>(new Set());
  const pendingIdSeq = useRef(0);
  const appRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);

  // Awaiting a turn result if the session is live AND (we have an optimistic
  // message in flight OR the transcript shows a user-input event more recent
  // than the most recent `result` event). The session-status gate prevents
  // the indicator from getting stuck on a read-only ended transcript when
  // the operator stops mid-turn or the subprocess crashes before emitting a
  // result. The events-derived clause means a viewer landing on a session
  // another phone just sent into still sees the thinking indicator.
  const sessionStatus = snapshot?.status ?? null;
  const awaitingResult = useMemo(() => {
    if (sessionStatus !== "live") return false;
    if (pendingMessages.length > 0) return true;
    let lastResultIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "result") {
        lastResultIdx = i;
        break;
      }
    }
    for (let i = lastResultIdx + 1; i < events.length; i++) {
      const e = events[i];
      if (e.type === "user") {
        const p = e.payload as CCUserPayload;
        if (typeof p.message?.content === "string") return true;
      }
      if (e.type === "assistant") return true;
      if (e.type === "stream_event") return true;
    }
    return false;
  }, [events, pendingMessages.length, sessionStatus]);

  // Auto-scroll only when the user is already pinned near the bottom. If the
  // operator has scrolled up to read earlier output, new messages must not
  // yank them back down. A locally-sent message (pendingMessages increases)
  // is treated as an intent to follow along, so re-stick to bottom in that
  // case.
  const stickToBottomRef = useRef(true);
  const prevPendingLenRef = useRef(0);
  useEffect(() => {
    const STICK_THRESHOLD = 80;
    const onScroll = () => {
      const doc = document.documentElement;
      const distFromBottom =
        doc.scrollHeight - window.scrollY - window.innerHeight;
      stickToBottomRef.current = distFromBottom < STICK_THRESHOLD;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (pendingMessages.length > prevPendingLenRef.current) {
      stickToBottomRef.current = true;
    }
    prevPendingLenRef.current = pendingMessages.length;
    if (stickToBottomRef.current) {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    }
  }, [events.length, pendingMessages.length, awaitingResult]);

  // Push the rendered top-bar / bottom-bar heights onto .app as CSS vars so
  // .events can pad first/last messages clear of the sticky bars. Both bars
  // resize at runtime — top bar grows when YOLO error chips appear, input
  // bar grows as the textarea expands and when the error row toggles — so
  // we re-measure via ResizeObserver. The bottom ref lands on whichever of
  // InputBox / EndedBanner is mounted; re-running on sessionStatus changes
  // re-binds the observer to the new node when the bar swaps.
  useLayoutEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const top = topBarRef.current;
    const bottom = bottomBarRef.current;
    const update = () => {
      if (top) app.style.setProperty("--top-bar-h", `${top.offsetHeight}px`);
      if (bottom)
        app.style.setProperty("--bottom-bar-h", `${bottom.offsetHeight}px`);
      else app.style.removeProperty("--bottom-bar-h");
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    if (top) ro.observe(top);
    if (bottom) ro.observe(bottom);
    return () => ro.disconnect();
  }, [sessionStatus]);

  // Reset per-session state when navigating between sids so stale events
  // from the previous session's EventSource don't leak into this view.
  useEffect(() => {
    setEvents([]);
    setResolutions(new Map());
    setYoloMode(false);
    setAllowedTools(new Set());
    setPendingMessages([]);
    seenIds.current = new Set();
    stickToBottomRef.current = true;
    prevPendingLenRef.current = 0;
  }, [sid]);

  // Drop optimistic bubbles when the session is no longer live so a
  // mid-turn Stop / subprocess crash doesn't leave a permanent
  // "delivered · awaiting reply" tag on the read-only transcript.
  useEffect(() => {
    if (sessionStatus !== "live") setPendingMessages([]);
  }, [sessionStatus]);

  const addPendingMessage = useCallback((text: string): number => {
    const localId = ++pendingIdSeq.current;
    setPendingMessages((prev) => [
      ...prev,
      { localId, text, sentAt: Date.now() },
    ]);
    return localId;
  }, []);

  const removePendingMessage = useCallback((localId: number) => {
    setPendingMessages((prev) => prev.filter((m) => m.localId !== localId));
  }, []);

  useEffect(() => {
    const ingest = (evt: EnvelopeEvent) => {
      if (seenIds.current.has(evt.id)) return;
      seenIds.current.add(evt.id);
      setEvents((prev) => [...prev, evt]);
      if (evt.type === "permission_resolved") {
        const p = evt.payload as {
          request_id?: string;
          decision?: "allow" | "deny";
        };
        if (p.request_id && p.decision) {
          const requestId = p.request_id;
          const decision = p.decision;
          setResolutions((prev) => {
            if (prev.get(requestId) === decision) return prev;
            const next = new Map(prev);
            next.set(requestId, decision);
            return next;
          });
        }
      }
      if (evt.type === "yolo_mode_changed") {
        const p = evt.payload as { enabled?: unknown };
        if (typeof p.enabled === "boolean") setYoloMode(p.enabled);
      }
      if (evt.type === "tool_allowlisted") {
        const p = evt.payload as { tool_name?: unknown };
        if (typeof p.tool_name === "string") {
          const name = p.tool_name;
          setAllowedTools((prev) => {
            if (prev.has(name)) return prev;
            const next = new Set(prev);
            next.add(name);
            return next;
          });
        }
      }
      // Replayed user input echoed by CC (--replay-user-messages) — drop
      // the matching optimistic bubble so we don't show it twice. For
      // slash commands CC echoes the expanded <command-message> blob, not
      // the original `/name args` invocation, so reconstruct that form
      // and also match on it; otherwise the bubble lingers forever and
      // keeps the thinking indicator stuck on.
      if (evt.type === "user") {
        const p = evt.payload as CCUserPayload;
        const content = p.message?.content;
        if (typeof content === "string") {
          const slash = parseSlashCommand(content);
          // Normalize whitespace so `/foo  bar` (typed) still matches
          // `/foo bar` (reconstructed) — parseSlashCommand collapses
          // inner spacing on its way out.
          const normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();
          const reconstructed = slash
            ? slash.args
              ? `/${slash.name} ${slash.args}`
              : `/${slash.name}`
            : null;
          const normalizedReconstructed =
            reconstructed === null ? null : normalizeWs(reconstructed);
          setPendingMessages((prev) => {
            const idx = prev.findIndex(
              (m) =>
                m.text === content ||
                (normalizedReconstructed !== null &&
                  normalizeWs(m.text) === normalizedReconstructed),
            );
            if (idx === -1) return prev;
            const next = prev.slice();
            next.splice(idx, 1);
            return next;
          });
        }
      }
    };

    if (!inMemory) {
      // Archived-on-disk session: no live stream, one-shot fetch. If the
      // /inbox reconnects later and learns the session is in-memory after
      // all (rare race at server startup), this effect re-runs and upgrades
      // to SSE.
      setStreamStatus("connecting");
      let cancelled = false;
      fetch(`/${encodeURIComponent(sid)}/events`)
        .then((r) => {
          if (!r.ok) throw new Error(`server returned ${r.status}`);
          return r.json() as Promise<{ events: EnvelopeEvent[] }>;
        })
        .then((data) => {
          if (cancelled) return;
          for (const evt of data.events) ingest(evt);
          setStreamStatus("disconnected");
        })
        .catch(() => {
          if (cancelled) return;
          setStreamStatus("disconnected");
        });
      return () => {
        cancelled = true;
      };
    }

    const es = new EventSource(`/${encodeURIComponent(sid)}/stream`);
    es.onopen = () => setStreamStatus("connected");
    es.onerror = () => setStreamStatus("disconnected");
    es.onmessage = (e) => {
      try {
        ingest(JSON.parse(e.data) as EnvelopeEvent);
      } catch {
        // malformed frame; ignore
      }
    };
    return () => es.close();
  }, [sid, inMemory]);

  const canInput = snapshot?.status === "live";
  // Only the bottom-most message bubble carries a timestamp. When a pending
  // bubble is in flight, that's the bottom; otherwise it's the latest text
  // event in the transcript.
  const latestEventId = useMemo(
    () => (pendingMessages.length > 0 ? null : lastMessageEventId(events)),
    [events, pendingMessages.length],
  );
  const inFlightAssistant = useInFlightAssistant(events, sid);
  const turnStart = useMemo(
    () => turnStartedAtMs(events, awaitingResult),
    [events, awaitingResult],
  );
  const elapsedSec = useElapsedSeconds(
    inFlightAssistant?.startedAt ?? turnStart,
    awaitingResult,
  );
  const lastPendingLocalId =
    pendingMessages.length > 0
      ? pendingMessages[pendingMessages.length - 1].localId
      : null;
  return (
    <div className="app" ref={appRef}>
      <SessionTopBar
        ref={topBarRef}
        sid={sid}
        snapshot={snapshot}
        streamStatus={streamStatus}
        inboxStatus={inboxStatus}
        eventCount={events.length}
        yoloMode={yoloMode}
        theme={theme}
        showSystemEvents={showSystemEvents}
        softThresholdTokens={softThresholdTokens}
        thresholdInput={thresholdInput}
        onThresholdChange={onSoftThresholdChange}
        onToggleSystemEvents={() => setShowSystemEvents((p) => !p)}
        onToggleTheme={onToggleTheme}
        onBack={onBack}
      />
      {compactSuggestion !== null && (
        <CompactSuggestionBanner
          sid={sid}
          tokens={compactSuggestion.tokens}
          onClear={onClearCompactSuggestion}
        />
      )}
      <MetricsStrip events={events} />
      <EventList
        events={events}
        resolutions={resolutions}
        allowedTools={allowedTools}
        sid={sid}
        sessionStatus={sessionStatus}
        showSystemEvents={showSystemEvents}
        latestEventId={latestEventId}
      />
      {pendingMessages.map((m) => (
        <PendingUserBubble
          key={m.localId}
          text={m.text}
          sentAt={m.sentAt}
          isLatest={m.localId === lastPendingLocalId}
        />
      ))}
      {awaitingResult && inFlightAssistant && (
        <InFlightAssistantRow message={inFlightAssistant} />
      )}
      {awaitingResult && (
        <ThinkingIndicator
          elapsedSec={elapsedSec}
          outputTokens={inFlightAssistant?.outputTokens ?? null}
        />
      )}
      {canInput && (
        <InputBox
          ref={bottomBarRef}
          sid={sid}
          onSend={addPendingMessage}
          onSendFailed={removePendingMessage}
          canStop={true}
        />
      )}
      {!canInput && snapshot?.status === "compacting" && (
        <CompactingBanner ref={bottomBarRef} />
      )}
      {!canInput &&
        snapshot?.status === "ended" &&
        snapshot.endReason === "compacted" && (
          <CompactedBanner
            key={sid}
            ref={bottomBarRef}
            sid={sid}
            successorSid={snapshot.successorSid}
            onOpenSuccessor={(nextSid) => {
              window.location.hash = `sid=${encodeURIComponent(nextSid)}`;
            }}
          />
        )}
      {!canInput &&
        snapshot?.status === "ended" &&
        snapshot.endReason !== "compacted" && (
          <EndedBanner ref={bottomBarRef} sid={sid} onResume={onResume} />
        )}
    </div>
  );
}

function PendingUserBubble({
  text,
  sentAt,
  isLatest,
}: {
  text: string;
  sentAt: number;
  isLatest: boolean;
}) {
  // Re-render once after the 2s threshold so the label rolls from "sending"
  // to "delivered, awaiting reply" without polling forever.
  const [, setTick] = useState(0);
  useEffect(() => {
    const elapsed = Date.now() - sentAt;
    const remaining = Math.max(0, 2000 - elapsed);
    const t = setTimeout(() => setTick((x) => x + 1), remaining + 50);
    return () => clearTimeout(t);
  }, [sentAt]);
  const slow = Date.now() - sentAt > 2000;
  return (
    <>
      {isLatest && (
        <div className="row row-user">
          <MessageTimestamp iso={new Date(sentAt).toISOString()} />
        </div>
      )}
      <div className="row row-user">
        <div className="bubble bubble-user bubble-user-pending">
          {text}
          <span className="bubble-pending-tag">
            {slow ? "delivered · awaiting reply" : "sending…"}
          </span>
        </div>
      </div>
    </>
  );
}

function ThinkingIndicator({
  elapsedSec,
  outputTokens,
}: {
  elapsedSec: number | null;
  outputTokens: number | null;
}) {
  const showElapsed = elapsedSec !== null && elapsedSec > 0;
  const showTokens = outputTokens !== null && outputTokens > 0;
  // Only the static "thinking" label sits in the live region — the elapsed
  // counter ticks every second and a polite re-announcement of "thinking ·
  // 47s · 1283 tok" each second is wildly noisy on a screen reader. The
  // outer container drops role=status; an inner span owns the announcement
  // with a stable accessible name and the meta is aria-hidden.
  return (
    <div className="row row-system">
      <div className="thinking-indicator">
        <span className="thinking-dot" aria-hidden="true" />
        <span className="thinking-dot" aria-hidden="true" />
        <span className="thinking-dot" aria-hidden="true" />
        <span
          className="thinking-label"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          thinking
        </span>
        {(showElapsed || showTokens) && (
          <span className="thinking-meta" aria-hidden="true">
            {showElapsed && ` · ${formatElapsedSeconds(elapsedSec!)}`}
            {showTokens && ` · ${outputTokens} tok`}
          </span>
        )}
      </div>
    </div>
  );
}

// Renders the live assistant turn reconstructed from --include-partial-messages
// stream events. Stays mounted only until the matching final `assistant` event
// arrives, at which point useInFlightAssistant returns null and the EventList's
// AssistantRow takes over with the canonical version.
function InFlightAssistantRow({ message }: { message: InFlightAssistant }) {
  const toolUseBlocks = message.blocks.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
      b.type === "tool_use",
  );
  return (
    <>
      {message.blocks.map((block, idx) => {
        const key = `inflight-${idx}`;
        if (block.type === "thinking") {
          if (block.thinking.length === 0) return null;
          return (
            <details key={key} className="row row-thinking" open>
              <summary>thinking · live</summary>
              <pre>{block.thinking}</pre>
            </details>
          );
        }
        if (block.type === "text") {
          if (block.text.length === 0) return null;
          return (
            <div key={key} className="row row-assistant">
              <div className="bubble bubble-assistant bubble-assistant-inflight">
                <Markdown rehypePlugins={[rehypeSanitize]}>
                  {block.text}
                </Markdown>
              </div>
            </div>
          );
        }
        return null;
      })}
      {toolUseBlocks.length > 0 && (
        <InFlightToolPanel blocks={toolUseBlocks} />
      )}
    </>
  );
}

// Collapsible "what's CC doing right now" panel that surfaces tool_use
// blocks reconstructed from in-flight stream_events. Closed by default —
// the operator only needs the call count + tool names at a glance to know
// the session is making progress, and can expand to see individual calls
// when something looks stuck.
function InFlightToolPanel({
  blocks,
}: {
  blocks: Array<Extract<ContentBlock, { type: "tool_use" }>>;
}) {
  return (
    <details className="tool-batch tool-batch-live">
      <summary className="tool-batch-summary">
        <span className="tool-batch-count">
          {blocks.length} tool call{blocks.length === 1 ? "" : "s"}
        </span>
        <span className="tool-batch-names">
          {summarizeToolNames(blocks.map((b) => b.name || "?"))}
        </span>
        <span className="tool-batch-status tool-batch-status-live">
          working
        </span>
      </summary>
      <div className="tool-batch-body">
        {blocks.map((block, idx) => {
          const preview = previewToolInput(block.name, block.input);
          return (
            <div
              key={`live-${idx}`}
              className="tool-entry tool-entry-live is-pending"
            >
              <div className="tool-entry-live-summary">
                <span className="tool-entry-name">{block.name || "?"}</span>
                <span className="tool-entry-preview">{preview}</span>
                <span className="tool-entry-status">running…</span>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function EndedBanner({
  ref,
  sid,
  onResume,
}: {
  ref?: Ref<HTMLDivElement>;
  sid: string;
  onResume: (parentSid: string) => Promise<string | null>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="session-ended-banner" ref={ref}>
      <div className="session-ended-text">
        Session ended · read-only transcript
      </div>
      <div className="session-ended-actions">
        <button
          type="button"
          className="btn-resume btn-resume-banner"
          disabled={pending}
          onClick={async () => {
            if (pending) return;
            setPending(true);
            setError(null);
            const err = await onResume(sid).catch((e) =>
              e instanceof Error ? e.message : "network error",
            );
            if (err) setError(err);
            setPending(false);
          }}
        >
          {pending ? "starting…" : "Resume in new session"}
        </button>
      </div>
      {error && (
        <div className="session-ended-error" role="alert">
          error: {error}
        </div>
      )}
    </div>
  );
}

function CompactedBanner({
  ref,
  sid,
  successorSid,
  onOpenSuccessor,
}: {
  ref?: Ref<HTMLDivElement>;
  sid: string;
  /**
   * Successor oakridgeSid surfaced from the snapshot. May be null when the
   * predecessor's compaction succeeded but the successor spawn or handoff
   * delivery failed (compact_succeeded_but_resume_failed) — the PWA still
   * shows the banner with the handoff body but the "open successor"
   * action is hidden.
   */
  successorSid: string | null;
  onOpenSuccessor: (nextSid: string) => void;
}) {
  // Default the handoff to expanded so an operator who taps a compacted
  // row lands directly on the rendered handoff (matches plan §1.8 "tap a
  // compacted session row → render handoff").
  const [showHandoff, setShowHandoff] = useState(true);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [handoffStatus, setHandoffStatus] = useState<
    "idle" | "loading" | "ok" | "missing" | "error"
  >("idle");

  useEffect(() => {
    if (!showHandoff) return;
    if (handoffStatus !== "idle") return;
    let cancelled = false;
    setHandoffStatus("loading");
    fetch(`/${encodeURIComponent(sid)}/handoff`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          setHandoffStatus("missing");
          return;
        }
        if (!r.ok) {
          setHandoffStatus("error");
          return;
        }
        const text = await r.text();
        if (cancelled) return;
        setHandoff(text);
        setHandoffStatus("ok");
      })
      .catch(() => {
        if (cancelled) return;
        setHandoffStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [showHandoff, sid, handoffStatus]);

  return (
    <div className="compacted-banner" ref={ref}>
      <div className="compacted-banner__row">
        <span className="compacted-banner__label">Compacted</span>
        {successorSid !== null ? (
          <button
            type="button"
            className="btn-resume btn-resume-banner compacted-banner__open"
            onClick={() => onOpenSuccessor(successorSid)}
            title={`Open successor session ${successorSid}`}
          >
            → session {successorSid.slice(0, 8)}
          </button>
        ) : (
          <span
            className="compacted-banner__no-successor"
            title="The successor session never started — the handoff is below for review."
          >
            (no successor — resume failed)
          </span>
        )}
        <button
          type="button"
          className="compacted-banner__toggle"
          onClick={() => setShowHandoff((p) => !p)}
          aria-expanded={showHandoff}
        >
          {showHandoff ? "Hide handoff" : "Show handoff"}
        </button>
      </div>
      {showHandoff && (
        <div className="compacted-banner__handoff">
          {handoffStatus === "loading" && (
            <div className="compacted-banner__status">loading handoff…</div>
          )}
          {handoffStatus === "missing" && (
            <div className="compacted-banner__status">
              no handoff document on disk for this session
            </div>
          )}
          {handoffStatus === "error" && (
            <div className="compacted-banner__status">
              failed to load handoff
            </div>
          )}
          {handoffStatus === "ok" && handoff !== null && (
            <Markdown rehypePlugins={[rehypeSanitize]}>{handoff}</Markdown>
          )}
        </div>
      )}
    </div>
  );
}

function CompactSuggestionBanner({
  sid,
  tokens,
  onClear,
}: {
  sid: string;
  tokens: number;
  onClear: () => void;
}) {
  return (
    <div className="compact-suggestion-banner">
      <span className="compact-suggestion-banner__text">
        Session is at {tokens.toLocaleString()} tokens — approaching the context limit.
      </span>
      <button
        type="button"
        className="compact-suggestion-banner__action"
        onClick={async () => {
          try {
            const res = await fetch(`/${encodeURIComponent(sid)}/compact`, {
              method: "POST",
            });
            if (res.ok) onClear();
          } catch {
            // keep banner visible so operator can retry
          }
        }}
      >
        Compact Now
      </button>
      <button
        type="button"
        className="compact-suggestion-banner__dismiss"
        onClick={onClear}
      >
        Dismiss
      </button>
    </div>
  );
}

function CompactingBanner({ ref }: { ref?: Ref<HTMLDivElement> }) {
  return (
    <div className="compacting-banner" ref={ref}>
      <span className="compacting-banner__dot" aria-hidden="true" />
      <span className="compacting-banner__dot" aria-hidden="true" />
      <span className="compacting-banner__dot" aria-hidden="true" />
      <span className="compacting-banner__label" role="status" aria-live="polite">
        compacting…
      </span>
      <span className="compacting-banner__hint">
        building handoff doc · successor will spawn when complete
      </span>
    </div>
  );
}


function MetricsStrip({ events }: { events: EnvelopeEvent[] }) {
  const m = useMemo(() => computeMetrics(events), [events]);
  if (m.turns === 0) return null;
  const last = m.last;
  // Cache reads are essentially free per Anthropic billing — surface them as
  // a separate stat so a big cache_read number doesn't make the operator
  // think they just burned a million-token turn.
  const lastBilled = last ? last.inT + last.cacheCreate + last.outT : 0;
  const totalBilled = m.totalIn + m.totalCacheCreate + m.totalOut;
  return (
    <details className="metrics-strip">
      <summary className="metrics-summary">
        {last && (
          <span className="metric" title="Last turn input (incl. cache creation) → output tokens">
            <span className="metric-label">last</span>
            <span className="metric-value">
              {fmtTokensCompact(last.inT + last.cacheCreate)}→
              {fmtTokensCompact(last.outT)}
            </span>
          </span>
        )}
        {last && last.dur > 0 && (
          <span className="metric" title="Last turn wall-clock duration">
            <span className="metric-value">{fmtDuration(last.dur)}</span>
          </span>
        )}
        {/* Once any turn this session has reported a non-zero cost, keep
            both cost chips visible even when an individual turn lands at $0
            (sub-cent rounding, fallback model, etc.) so the strip layout
            doesn't flicker turn to turn. Pure $0 sessions (Claude Max only)
            still hide both. */}
        {last && m.totalCost > 0 && (
          <span className="metric" title="Last turn cost (Anthropic API billing; $0 on Claude Max)">
            <span className="metric-value">{fmtCost(last.cost)}</span>
          </span>
        )}
        <span className="metric-sep">·</span>
        <span className="metric" title="Cumulative billed tokens across all turns this session">
          <span className="metric-label">session</span>
          <span className="metric-value">{fmtTokensCompact(totalBilled)}</span>
        </span>
        <span className="metric" title={`${m.turns} turn${m.turns === 1 ? "" : "s"}`}>
          <span className="metric-value">
            {m.turns} turn{m.turns === 1 ? "" : "s"}
          </span>
        </span>
        {m.totalCost > 0 && (
          <span className="metric" title="Cumulative session cost">
            <span className="metric-value">{fmtCost(m.totalCost)}</span>
          </span>
        )}
      </summary>
      <div className="metrics-detail">
        {last && (
          <div className="metrics-detail-section">
            <div className="metrics-detail-heading">Last turn</div>
            <dl>
              <dt>input</dt>
              <dd>{last.inT.toLocaleString()}</dd>
              <dt>output</dt>
              <dd>{last.outT.toLocaleString()}</dd>
              <dt>cache create</dt>
              <dd>{last.cacheCreate.toLocaleString()}</dd>
              <dt>cache read</dt>
              <dd>{last.cacheRead.toLocaleString()}</dd>
              <dt>duration</dt>
              <dd>{fmtDuration(last.dur) || "—"}</dd>
              <dt>cost</dt>
              <dd>{last.cost > 0 ? fmtCost(last.cost) : "—"}</dd>
              <dt>billed</dt>
              <dd>{lastBilled.toLocaleString()}</dd>
            </dl>
          </div>
        )}
        <div className="metrics-detail-section">
          <div className="metrics-detail-heading">Session ({m.turns} turns)</div>
          <dl>
            <dt>input</dt>
            <dd>{m.totalIn.toLocaleString()}</dd>
            <dt>output</dt>
            <dd>{m.totalOut.toLocaleString()}</dd>
            <dt>cache create</dt>
            <dd>{m.totalCacheCreate.toLocaleString()}</dd>
            <dt>cache read</dt>
            <dd>{m.totalCacheRead.toLocaleString()}</dd>
            <dt>duration</dt>
            <dd>{fmtDuration(m.totalDur) || "—"}</dd>
            <dt>cost</dt>
            <dd>{m.totalCost > 0 ? fmtCost(m.totalCost) : "—"}</dd>
            <dt>billed</dt>
            <dd>{totalBilled.toLocaleString()}</dd>
          </dl>
        </div>
      </div>
    </details>
  );
}

function SessionTopBar({
  ref,
  sid,
  snapshot,
  streamStatus,
  inboxStatus,
  eventCount,
  yoloMode,
  theme,
  showSystemEvents,
  softThresholdTokens,
  thresholdInput,
  onThresholdChange,
  onToggleSystemEvents,
  onToggleTheme,
  onBack,
}: {
  ref?: Ref<HTMLElement>;
  sid: string;
  snapshot: SessionSnapshot | null;
  streamStatus: Status;
  inboxStatus: Status;
  eventCount: number;
  yoloMode: boolean;
  theme: Theme;
  showSystemEvents: boolean;
  softThresholdTokens: number;
  thresholdInput: string;
  onThresholdChange: (n: number, input: string) => void;
  onToggleSystemEvents: () => void;
  onToggleTheme: () => void;
  onBack: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canToggleYolo = snapshot?.status === "live";
  async function toggleYolo() {
    if (pending || !canToggleYolo) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/${encodeURIComponent(sid)}/yolo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !yoloMode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setError(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
      setPending(false);
    }
  }
  // Show stream status when on a live session, inbox status otherwise —
  // stream status on an archived-only view is misleading ("disconnected"
  // just means the one-shot fetch finished).
  const shownStatus = snapshot?.status === "live" ? streamStatus : inboxStatus;
  return (
    <header className="top-bar" ref={ref}>
      <button
        type="button"
        className="back-button"
        onClick={onBack}
        aria-label="Back to session list"
        title="Back to session list"
      >
        ←
      </button>
      <span className={`status status-${shownStatus}`}>{shownStatus}</span>
      <span className="event-count">{eventCount} events</span>
      <button
        type="button"
        className={`theme-toggle ${showSystemEvents ? "is-on" : ""}`}
        onClick={onToggleSystemEvents}
        title={
          showSystemEvents
            ? "Hide hook lifecycle and other low-signal system events"
            : "Show hook lifecycle and other low-signal system events"
        }
        aria-pressed={showSystemEvents}
        aria-label="Toggle system events visibility"
      >
        SYS
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
      <button
        type="button"
        className={`yolo-toggle ${yoloMode ? "is-on" : ""}`}
        onClick={() => void toggleYolo()}
        disabled={pending || !canToggleYolo}
        title={
          !canToggleYolo
            ? "YOLO only toggleable while the session is live"
            : yoloMode
              ? "YOLO mode on — every tool call auto-approves"
              : "Tap to enable YOLO mode (auto-approve every tool call)"
        }
        aria-pressed={yoloMode}
      >
        {yoloMode ? "YOLO ON" : "YOLO"}
      </button>
      {error && (
        <span className="yolo-error" title={error} role="alert">
          ⚠ {error}
        </span>
      )}
      <span
        className="session-label"
        title={
          snapshot
            ? sessionLabelTitle(snapshot, sid)
            : `session ${sid}`
        }
      >
        <span className="session-label-name">
          {snapshot?.name || sid.slice(0, 8)}
        </span>
        {snapshot && (() => {
          // projectWorkdir is the operator's original repo when worktrees
          // are on; falls back to workdir for pre-Phase-1 archived
          // sessions where projectWorkdir is null.
          const project = snapshot.projectWorkdir ?? snapshot.workdir;
          if (!project) return null;
          // worktreeBranch slug — strip the kbbl/ prefix and show what's
          // left ("abc12345" or "abc12345-r1") next to the project basename
          // so the operator can tell at a glance which branch this
          // session's edits land on.
          const slug = snapshot.worktreeBranch
            ? snapshot.worktreeBranch.replace(/^kbbl\//, "")
            : null;
          return (
            <span className="session-label-workdir">
              {workdirBasename(project)}
              {slug && <span className="session-label-slug"> › {slug}</span>}
            </span>
          );
        })()}
      </span>
      <label className="threshold-setting" title="Compact suggestion threshold (tokens)">
        <span className="threshold-setting__label">Compact at</span>
        <input
          type="number"
          className="threshold-setting__input"
          value={thresholdInput}
          min={1000}
          step={1000}
          onChange={(e) => onThresholdChange(softThresholdTokens, e.target.value)}
          onBlur={async () => {
            const n = Number(thresholdInput);
            if (!Number.isInteger(n) || n <= 0) {
              onThresholdChange(softThresholdTokens, String(softThresholdTokens));
              return;
            }
            try {
              const res = await fetch("/config", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ softThresholdTokens: n }),
              });
              if (res.ok) {
                onThresholdChange(n, String(n));
              } else {
                onThresholdChange(softThresholdTokens, String(softThresholdTokens));
              }
            } catch {
              onThresholdChange(softThresholdTokens, String(softThresholdTokens));
            }
          }}
        />
        <span className="threshold-setting__unit">tok</span>
      </label>
    </header>
  );
}



async function fetchTaskAndHandoffs(taskId: number): Promise<TaskFetchState> {
  try {
    const [taskRes, handoffsRes] = await Promise.all([
      fetch(`/safir/tasks/${taskId}`),
      fetch(`/safir/tasks/${taskId}/handoffs`),
    ]);
    if (taskRes.status === 404) return { kind: "not_found" };
    if (taskRes.status === 502 || handoffsRes.status === 502) {
      return { kind: "safir_down" };
    }
    if (!taskRes.ok) {
      return {
        kind: "error",
        status: taskRes.status,
        message: `task fetch failed: HTTP ${taskRes.status}`,
      };
    }
    if (!handoffsRes.ok) {
      return {
        kind: "error",
        status: handoffsRes.status,
        message: `handoffs fetch failed: HTTP ${handoffsRes.status}`,
      };
    }
    const task = (await taskRes.json()) as SafirTask;
    const handoffs = (await handoffsRes.json()) as SafirHandoff[];
    return { kind: "ok", task, handoffs };
  } catch {
    // Network failure before kbbl could even respond — treat the same as
    // safir-down from the operator's perspective.
    return { kind: "safir_down" };
  }
}

function TaskView({
  taskId,
  theme,
  safirWebUrl,
  onToggleTheme,
  onBack,
}: {
  taskId: number;
  theme: Theme;
  safirWebUrl: string;
  onToggleTheme: () => void;
  onBack: () => void;
}) {
  const [state, setState] = useState<TaskFetchState>({ kind: "loading" });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    setExpanded(new Set());
    fetchTaskAndHandoffs(taskId).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className={`task-view theme-${theme}`}>
      <header className="task-view__header">
        <button type="button" className="task-view__back" onClick={onBack}>
          ← inbox
        </button>
        <span className="task-view__title">task #{taskId}</span>
        <a
          className="task-view__open-safir"
          href={`${safirWebUrl.replace(/\/+$/, "")}/tasks/${taskId}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open this task in safir"
          title="Open in safir"
        >
          open in safir ↗
        </a>
        <button
          type="button"
          className="task-view__theme"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? "☼" : "☾"}
        </button>
      </header>

      {state.kind === "loading" && (
        <div className="task-view__status">loading…</div>
      )}
      {state.kind === "not_found" && (
        <div className="task-view__status">
          task #{taskId} not found in safir
        </div>
      )}
      {state.kind === "safir_down" && (
        <div className="task-view__status">
          safir is unreachable — is it running on the configured port?
        </div>
      )}
      {state.kind === "error" && (
        <div className="task-view__status">{state.message}</div>
      )}
      {state.kind === "ok" && (
        <Fragment>
          <section className="task-view__meta">
            <h1>{state.task.title}</h1>
            <dl>
              <dt>project</dt>
              <dd>{state.task.project_id}</dd>
              <dt>status</dt>
              <dd>{state.task.status}</dd>
              {state.task.parent_id !== null && (
                <Fragment>
                  <dt>parent task</dt>
                  <dd>
                    <a
                      href={`#task=${state.task.parent_id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        window.location.hash = `task=${state.task.parent_id}`;
                      }}
                    >
                      #{state.task.parent_id}
                    </a>
                  </dd>
                </Fragment>
              )}
            </dl>
          </section>
          <section className="task-view__handoffs">
            <h2>handoffs ({state.handoffs.length})</h2>
            {state.handoffs.length === 0 && (
              <div className="task-view__status">no handoffs yet</div>
            )}
            {state.handoffs.map((h) => {
              const isOpen = expanded.has(h.id);
              return (
                <article
                  key={h.id}
                  className={`handoff-card${isOpen ? " handoff-card--open" : ""}`}
                >
                  <button
                    type="button"
                    className="handoff-card__summary"
                    onClick={() => toggle(h.id)}
                  >
                    <span className="handoff-card__ts">{h.produced_at}</span>
                    <span className="handoff-card__role">{h.role}</span>
                    {h.goal && (
                      <span className="handoff-card__goal">{h.goal}</span>
                    )}
                  </button>
                  {isOpen && (
                    <div className="handoff-card__body">
                      <Markdown rehypePlugins={[rehypeSanitize]}>
                        {h.raw_markdown}
                      </Markdown>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        </Fragment>
      )}
    </div>
  );
}


function EventList({
  events,
  resolutions,
  allowedTools,
  sid,
  sessionStatus,
  showSystemEvents,
  latestEventId,
}: {
  events: EnvelopeEvent[];
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
  sid: string;
  sessionStatus: SessionStatus | null;
  showSystemEvents: boolean;
  latestEventId: number | null;
}) {
  const items = useMemo(
    () => buildListItems(events, resolutions, showSystemEvents),
    [events, resolutions, showSystemEvents],
  );
  return (
    <div className="events">
      {items.map((item) => {
        if (item.kind === "tool_batch") {
          return (
            <ToolBatchSection key={`batch-${item.firstId}`} events={item.events} />
          );
        }
        if (item.kind === "compact") {
          return (
            <CompactingRow
              key={`compact-${item.startEvent.id}`}
              startEvent={item.startEvent}
              doneEvent={item.doneEvent}
            />
          );
        }
        return (
          <EventRow
            key={item.event.id}
            event={item.event}
            resolutions={resolutions}
            allowedTools={allowedTools}
            sid={sid}
            sessionStatus={sessionStatus}
            showSystemEvents={showSystemEvents}
            isLatest={item.event.id === latestEventId}
          />
        );
      })}
    </div>
  );
}


function ToolBatchSection({ events }: { events: EnvelopeEvent[] }) {
  const uses: ToolUseEntry[] = [];
  const results = new Map<string, ToolResultEntry>();
  for (const e of events) {
    if (e.type === "assistant") {
      const p = e.payload as CCAssistantPayload;
      for (const b of p.message?.content ?? []) {
        if (b.type === "tool_use") {
          uses.push({ id: b.id, name: b.name, input: b.input, eventId: e.id });
        }
      }
    } else if (e.type === "user") {
      const p = e.payload as CCUserPayload;
      const content = p.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "tool_result") {
            results.set(b.tool_use_id, {
              content: b.content,
              isError: !!b.is_error,
              eventId: e.id,
            });
          }
        }
      }
    }
  }
  if (uses.length === 0) return null;
  const errCount = uses.reduce(
    (n, u) => n + (results.get(u.id)?.isError ? 1 : 0),
    0,
  );
  return (
    <details className="tool-batch">
      <summary className="tool-batch-summary">
        <span className="tool-batch-count">
          {uses.length} tool call{uses.length === 1 ? "" : "s"}
        </span>
        <span className="tool-batch-names">
          {summarizeToolNames(uses.map((u) => u.name))}
        </span>
        {errCount > 0 && (
          <span className="tool-batch-errors">
            {errCount} error{errCount === 1 ? "" : "s"}
          </span>
        )}
      </summary>
      <div className="tool-batch-body">
        {uses.map((use) => (
          <ToolBatchEntry
            key={`${use.eventId}-${use.id}`}
            use={use}
            result={results.get(use.id) ?? null}
          />
        ))}
      </div>
    </details>
  );
}


// Memoized: a YOLO-mode batch can carry 50+ entries each holding a
// non-trivial input/result payload. Without memo every transcript scroll /
// SSE event re-runs the full JSON.stringify on every entry. Inputs are
// stable once they arrive (results land once, then never change), so memo
// against the use+result identity is safe.
const ToolBatchEntry = memo(function ToolBatchEntry({
  use,
  result,
}: {
  use: ToolUseEntry;
  result: ToolResultEntry | null;
}) {
  const inputPreview = useMemo(
    () => previewToolInput(use.name, use.input),
    [use.name, use.input],
  );
  const inputJson = useMemo(
    () => JSON.stringify(use.input, null, 2),
    [use.input],
  );
  const resultText = useMemo(() => {
    if (!result) return "";
    return typeof result.content === "string"
      ? result.content
      : (JSON.stringify(result.content ?? null) ?? "null");
  }, [result]);
  return (
    <details
      className={`tool-entry ${result?.isError ? "is-error" : ""} ${result ? "" : "is-pending"}`}
    >
      <summary>
        <span className="tool-entry-name">{use.name}</span>
        <span className="tool-entry-preview">{inputPreview}</span>
        {!result && <span className="tool-entry-status">pending…</span>}
        {result?.isError && <span className="tool-entry-status">error</span>}
      </summary>
      <div className="tool-entry-body">
        <div className="tool-entry-section-label">input</div>
        <pre className="tool-entry-block">{inputJson}</pre>
        {result && (
          <>
            <div className="tool-entry-section-label">
              result{result.isError ? " (error)" : ""}
            </div>
            <pre className="tool-entry-block">{resultText || "(empty)"}</pre>
          </>
        )}
      </div>
    </details>
  );
});

// Most-common tools have a recognizable single field that makes a far better
// inline preview than a JSON dump. Fall back to the raw JSON for anything
// else; the operator can still expand for the full input.

function EventRow({
  event,
  resolutions,
  allowedTools,
  sid,
  sessionStatus,
  showSystemEvents,
  isLatest,
}: {
  event: EnvelopeEvent;
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
  sid: string;
  sessionStatus: SessionStatus | null;
  showSystemEvents: boolean;
  isLatest: boolean;
}) {
  // stream_event deltas are reconstructed by InFlightAssistantRow; never
  // surface them as a row, even with showSystemEvents on.
  if (event.type === "stream_event") return null;
  if (!showSystemEvents && isLowSignalEvent(event)) return null;
  switch (event.type) {
    case "user":
      return (
        <UserRow
          event={event}
          showSystemEvents={showSystemEvents}
          isLatest={isLatest}
        />
      );
    case "assistant":
      return (
        <AssistantRow
          event={event}
          showSystemEvents={showSystemEvents}
          isLatest={isLatest}
        />
      );
    case "permission_request":
      return (
        <PermissionRow
          event={event}
          resolutions={resolutions}
          allowedTools={allowedTools}
          sid={sid}
          sessionStatus={sessionStatus}
          showSystemEvents={showSystemEvents}
        />
      );
    case "permission_resolved":
      // folded into the matching permission_request card
      return null;
    case "permission_auto_approved":
      if (!showSystemEvents) return null;
      return <AutoApprovedNotice event={event} />;
    case "permission_auto_denied":
      if (!showSystemEvents) return null;
      return <AutoDeniedNotice event={event} />;
    case "yolo_mode_changed":
    case "tool_allowlisted":
      return <SystemNotice event={event} compact={!showSystemEvents} />;
    case "system":
    case "session_started":
    case "subprocess_exited":
    case "subprocess_stderr":
    case "rate_limit_event":
    case "result":
    case "cc_session_id_observed":
      return <SystemNotice event={event} compact={!showSystemEvents} />;
    default:
      return <UnknownRow event={event} compact={!showSystemEvents} />;
  }
}


function UserRow({
  event,
  showSystemEvents,
  isLatest,
}: {
  event: EnvelopeEvent;
  showSystemEvents: boolean;
  isLatest: boolean;
}) {
  const p = event.payload as CCUserPayload & { isSynthetic?: boolean };
  const content = p.message?.content;

  // CC stamps post-compact summaries and skill-body injections with
  // isSynthetic. The summary is multi-page text; rendering it as a user
  // bubble misattributes it to the operator. Collapse behind an expand
  // affordance — the previous compact pill already marked when it ran.
  if (p.isSynthetic === true) {
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((b) =>
                b.type === "text"
                  ? b.text
                  : JSON.stringify(b, null, 2),
              )
              .join("\n\n")
          : JSON.stringify(content, null, 2);
    return (
      <div className="row row-user">
        <details className="bubble bubble-user bubble-user-slash">
          <summary>
            <span className="bubble-slash-name">[compacted — expand]</span>
          </summary>
          <pre className="bubble-slash-body">{text}</pre>
        </details>
      </div>
    );
  }

  if (typeof content === "string") {
    const slash = parseSlashCommand(content);
    if (slash) {
      return (
        <>
          {isLatest && (
            <div className="row row-user">
              <MessageTimestamp iso={event.ts} />
            </div>
          )}
          <div className="row row-user">
            <details className="bubble bubble-user bubble-user-slash">
              <summary>
                <span className="bubble-slash-name">/{slash.name}</span>
                {slash.args && (
                  <span className="bubble-slash-args">{slash.args}</span>
                )}
              </summary>
              <pre className="bubble-slash-body">{content}</pre>
            </details>
          </div>
        </>
      );
    }
    const stdout = parseLocalCommandStdout(content);
    if (stdout !== null) {
      const trimmed = stdout.trim();
      const firstLine = trimmed.split("\n", 1)[0] ?? "";
      return (
        <div className="row row-system" title={`event #${event.id}`}>
          <details className="notice">
            <summary>
              <span className="notice-tag">stdout</span>
              {firstLine || "(empty)"}
            </summary>
            <pre className="bubble-slash-body">{stdout}</pre>
          </details>
        </div>
      );
    }
    return (
      <>
        {isLatest && (
          <div className="row row-user">
            <MessageTimestamp iso={event.ts} />
          </div>
        )}
        <div className="row row-user">
          <div className="bubble bubble-user">{content}</div>
        </div>
      </>
    );
  }

  if (Array.isArray(content)) {
    return (
      <>
        {content.map((block, idx) => {
          if (block.type === "tool_result") {
            return (
              <ToolResultCard
                key={`${event.id}-${idx}`}
                block={block}
                eventId={event.id}
              />
            );
          }
          return (
            <UnknownRow
              key={`${event.id}-${idx}`}
              event={event}
              compact={!showSystemEvents}
            />
          );
        })}
      </>
    );
  }
  return <UnknownRow event={event} compact={!showSystemEvents} />;
}

function AssistantRow({
  event,
  showSystemEvents,
  isLatest,
}: {
  event: EnvelopeEvent;
  showSystemEvents: boolean;
  isLatest: boolean;
}) {
  const p = event.payload as CCAssistantPayload;
  const blocks = p.message?.content ?? [];
  // Pin the timestamp to the last text block in this event so a turn that
  // ends with a tool_use doesn't drop the stamp on the wrong card.
  let lastTextIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  return (
    <>
      {blocks.map((block, idx) => {
        const key = `${event.id}-${idx}`;
        if (block.type === "text") {
          const showTs = isLatest && idx === lastTextIdx;
          return (
            <Fragment key={key}>
              {showTs && (
                <div className="row row-assistant">
                  <MessageTimestamp iso={event.ts} />
                </div>
              )}
              <div className="row row-assistant">
                <div className="bubble bubble-assistant">
                  <Markdown rehypePlugins={[rehypeSanitize]}>
                    {block.text}
                  </Markdown>
                </div>
              </div>
            </Fragment>
          );
        }
        if (block.type === "thinking") {
          return (
            <details key={key} className="row row-thinking">
              <summary>thinking</summary>
              <pre>{block.thinking}</pre>
            </details>
          );
        }
        if (block.type === "tool_use") {
          return <ToolUseCard key={key} block={block} />;
        }
        return (
          <UnknownRow
            key={key}
            event={event}
            compact={!showSystemEvents}
          />
        );
      })}
    </>
  );
}

function ToolUseCard({
  block,
}: {
  block: Extract<ContentBlock, { type: "tool_use" }>;
}) {
  // JSON.stringify(undefined) returns undefined, not the string "undefined";
  // coalesce to null so preview is always a string even for malformed inputs.
  const preview = JSON.stringify(block.input ?? null) ?? "null";
  const short = preview.length > 80 ? preview.slice(0, 80) + "…" : preview;
  return (
    <details className="card card-tool-use">
      <summary>
        <span className="card-label">tool_use</span>
        <span className="card-name">{block.name}</span>
        <span className="card-preview">{short}</span>
      </summary>
      <pre className="card-body">{JSON.stringify(block.input, null, 2)}</pre>
    </details>
  );
}

function ToolResultCard({
  block,
  eventId,
}: {
  block: Extract<ContentBlock, { type: "tool_result" }>;
  eventId: number;
}) {
  const content =
    typeof block.content === "string"
      ? block.content
      : (JSON.stringify(block.content ?? null) ?? "null");
  const preview = content.length > 80 ? content.slice(0, 80) + "…" : content;
  return (
    <details
      className={`card card-tool-result ${block.is_error ? "is-error" : ""}`}
    >
      <summary>
        <span className="card-label">
          tool_result{block.is_error ? " (error)" : ""}
        </span>
        <span className="card-preview">{preview || <em>empty</em>}</span>
      </summary>
      <pre className="card-body">{content}</pre>
      <div className="card-footer">id #{eventId} · tool_use_id {block.tool_use_id.slice(0, 12)}…</div>
    </details>
  );
}


function PermissionRow({
  event,
  resolutions,
  allowedTools,
  sid,
  sessionStatus,
  showSystemEvents,
}: {
  event: EnvelopeEvent;
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
  sid: string;
  sessionStatus: SessionStatus | null;
  showSystemEvents: boolean;
}) {
  const p = event.payload as PermissionRequestPayload;
  const resolution = resolutions.get(p.request_id);
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [approveForTaskPending, setApproveForTaskPending] = useState(false);

  if (resolution) {
    // Compact mode: drop the post-resolution notice entirely. The next event
    // (the actual tool_use / tool_result) is enough confirmation that the
    // approval went through.
    if (!showSystemEvents) return null;
    return (
      <div className="row row-system">
        <div className={`notice notice-${resolution}`}>
          {resolution === "allow" ? "approved" : "denied"} · {p.tool_name}
        </div>
      </div>
    );
  }

  // Only collapse to a read-only notice when the session is definitively
  // ended. For "starting" or a still-loading inbox snapshot (null), fall
  // through to the normal buttons — realistic case is a brief window where
  // the inbox hasn't delivered the snapshot yet, and the server will
  // 404/503 if the operator taps before it's ready. "session ended"
  // messaging is wrong for those cases.
  if (sessionStatus === "ended") {
    return (
      <div className="row row-system">
        <div className="notice notice-muted">
          unresolved · {p.tool_name} (session ended)
        </div>
      </div>
    );
  }

  async function decide(
    decision: "approve" | "deny",
    scope: "once" | "always" = "once",
  ) {
    if (localPending) return;
    setLocalPending(true);
    setLocalError(null);
    try {
      const res = await fetch(`/${encodeURIComponent(sid)}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: p.request_id,
          decision,
          scope,
        }),
      });
      if (!res.ok) {
        // Mirror InputBox: surface the server's JSON `error` field if
        // present so the operator sees `scope must be...` etc instead of
        // a bare status code.
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setLocalError(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "request failed");
    } finally {
      setLocalPending(false);
    }
  }

  async function approveForTask() {
    if (approveForTaskPending || localPending) return;
    setApproveForTaskPending(true);
    setLocalError(null);
    try {
      const res = await fetch(
        `/${encodeURIComponent(sid)}/permission/approve-for-task`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool: p.tool_name }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setLocalError(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
        return;
      }
      // Profile persisted — also resolve the current pending request
      await decide("approve");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "request failed");
    } finally {
      setApproveForTaskPending(false);
    }
  }

  const inputPreview = JSON.stringify(p.tool_input, null, 2);
  // If the tool is already on the session allowlist, hide the redundant
  // "always allow" button — server would have auto-approved this request
  // had it arrived after the allowlist entry, so a stale parked card might
  // still show it; one tap suffices.
  const showAlways = !allowedTools.has(p.tool_name);

  return (
    <div className="card card-permission">
      <div className="card-permission-header">Approve {p.tool_name}?</div>
      <pre className="card-body">{inputPreview}</pre>
      {localError && <div className="card-error">error: {localError}</div>}
      <div className="card-permission-buttons">
        <button
          type="button"
          className="btn-deny"
          disabled={localPending || approveForTaskPending}
          onClick={() => void decide("deny")}
        >
          Deny
        </button>
        {showAlways && (
          <button
            type="button"
            className="btn-always"
            disabled={localPending || approveForTaskPending}
            onClick={() => void decide("approve", "always")}
            title={`Approve and auto-allow all future ${p.tool_name} calls this session`}
          >
            Always {p.tool_name}
          </button>
        )}
        <button
          type="button"
          className="btn-approve-task"
          disabled={localPending || approveForTaskPending}
          onClick={() => void approveForTask()}
          title={`Approve and remember for this task (persists across sessions)`}
        >
          {approveForTaskPending ? "Saving…" : "Approve for task"}
        </button>
        <button
          type="button"
          className="btn-approve"
          disabled={localPending || approveForTaskPending}
          onClick={() => void decide("approve")}
        >
          Approve
        </button>
      </div>
    </div>
  );
}

function AutoApprovedNotice({ event }: { event: EnvelopeEvent }) {
  const p = (event.payload ?? {}) as {
    tool_name?: unknown;
    reason?: unknown;
  };
  const tool = typeof p.tool_name === "string" ? p.tool_name : "tool";
  const reason =
    p.reason === "yolo"
      ? "yolo"
      : typeof p.reason === "string" && p.reason.startsWith("profile:")
        ? p.reason
        : "always allow";
  return (
    <div className="row row-system">
      <div className="notice notice-allow">
        auto-approved · {tool} <span className="notice-tag">({reason})</span>
      </div>
    </div>
  );
}

function AutoDeniedNotice({ event }: { event: EnvelopeEvent }) {
  const p = (event.payload ?? {}) as {
    tool_name?: unknown;
    reason?: unknown;
  };
  const tool = typeof p.tool_name === "string" ? p.tool_name : "tool";
  const reason = typeof p.reason === "string" ? p.reason : "profile";
  return (
    <div className="row row-system">
      <div className="notice notice-deny">
        auto-denied · {tool} <span className="notice-tag">({reason})</span>
      </div>
    </div>
  );
}

function CompactingRow({
  startEvent,
  doneEvent,
}: {
  startEvent: EnvelopeEvent;
  doneEvent: EnvelopeEvent | null;
}) {
  const startMs = useMemo(() => parseIsoMs(startEvent.ts), [startEvent.ts]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (doneEvent) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [doneEvent]);

  if (doneEvent) {
    const doneMs = parseIsoMs(doneEvent.ts);
    const elapsed =
      startMs !== null && doneMs !== null
        ? Math.max(0, Math.round((doneMs - startMs) / 1000))
        : null;
    const result =
      (doneEvent.payload as SystemStatusPayload | null)?.compact_result ??
      "done";
    return (
      <div className="row row-system" title={`event #${startEvent.id}`}>
        <div className="notice">
          compacted{elapsed !== null ? ` in ${elapsed}s` : ""} ({result})
        </div>
      </div>
    );
  }
  const elapsed =
    startMs === null ? null : Math.max(0, Math.round((now - startMs) / 1000));
  return (
    <div className="row row-system" title={`event #${startEvent.id}`}>
      <div className="notice">
        {elapsed === null ? "compacting…" : `compacting (${elapsed}s)…`}
      </div>
    </div>
  );
}

function SystemNotice({
  event,
  compact,
}: {
  event: EnvelopeEvent;
  compact: boolean;
}) {
  const p = (event.payload as Record<string, unknown>) ?? {};
  let text: string;
  switch (event.type) {
    case "session_started":
      text = `session started (${String(p.sessionId ?? "").slice(0, 8)}…)`;
      break;
    case "subprocess_exited":
      text = `subprocess exited: ${String(p.reason ?? "unknown")} (code ${String(p.code ?? "?")})`;
      break;
    case "subprocess_stderr":
      text = `stderr: ${String(p.line ?? "")}`;
      break;
    case "rate_limit_event":
      text = "rate limit event";
      break;
    case "yolo_mode_changed":
      text = `yolo mode ${p.enabled ? "enabled" : "disabled"}`;
      break;
    case "tool_allowlisted":
      text = `always allow: ${String(p.tool_name ?? "?")}`;
      break;
    case "result":
      text = formatResultText(p);
      break;
    case "cc_session_id_observed":
      text = `CC session id ${String(p.cc_session_id ?? "").slice(0, 8)}…`;
      break;
    case "system": {
      const raw = event.payload as { subtype?: string } | null;
      text = `system: ${String(raw?.subtype ?? "event")}`;
      break;
    }
    default:
      text = event.type;
  }
  // In compact mode the `#N` sequence id is gutter info — moved to the row's
  // title attribute so it's still inspectable on hover but doesn't bracket
  // every system line. Operators told us the bare id was never actionable.
  return (
    <div className="row row-system" title={`event #${event.id}`}>
      <div className="notice">
        {!compact && <span className="notice-tag">#{event.id}</span>}
        {text}
      </div>
    </div>
  );
}


function UnknownRow({
  event,
  compact,
}: {
  event: EnvelopeEvent;
  compact: boolean;
}) {
  return (
    <div className="row row-system" title={`event #${event.id}`}>
      <div className="notice notice-muted">
        {!compact && <span className="notice-tag">#{event.id}</span>}
        unknown type={event.type}
      </div>
    </div>
  );
}

function InputBox({
  ref,
  sid,
  onSend,
  onSendFailed,
  canStop,
}: {
  ref?: Ref<HTMLDivElement>;
  sid: string;
  onSend: (text: string) => number;
  onSendFailed: (localId: number) => void;
  canStop: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const payload = text.trim();
    if (!payload || sending) return;
    // Clear the input + add the optimistic bubble *before* the network round
    // trip so the operator gets immediate "I sent" feedback even on a slow
    // tailnet. Two failure modes, treated differently:
    //  - Explicit non-OK response (4xx/5xx): server definitively rejected.
    //    Roll the bubble back, restore the text, surface the server's
    //    error so the operator can edit/retry without losing the message.
    //  - Thrown fetch (network drop, server crash mid-request): we don't
    //    know whether the server processed it. Leave the bubble in place
    //    and warn that delivery is uncertain — re-sending could double the
    //    command if the original actually went through.
    setText("");
    setSending(true);
    setError(null);
    const localId = onSend(payload);
    try {
      const res = await fetch(`/${encodeURIComponent(sid)}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        const msg =
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`;
        onSendFailed(localId);
        setText(payload);
        setError(msg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setError(
        `${msg} — delivery status unknown, check the transcript before retrying`,
      );
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setError(null);
    try {
      const res = await fetch(`/sessions/${encodeURIComponent(sid)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setError(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
      setStopping(false);
      setConfirmStop(false);
    }
  }

  return (
    <div className="input-bar" ref={ref}>
      {error && <div className="input-error">error: {error}</div>}
      <div className="input-bar-row">
        {canStop && (
          <button
            type="button"
            className={`btn-stop ${confirmStop ? "is-confirming" : ""}`}
            onClick={() => {
              if (stopping) return;
              if (confirmStop) {
                void stop();
              } else {
                setConfirmStop(true);
              }
            }}
            onBlur={() => setConfirmStop(false)}
            disabled={stopping}
            title="Kills the CC subprocess. Resume from the ended banner to fork a new session with the same context."
          >
            {stopping ? "stopping…" : confirmStop ? "confirm" : "Stop"}
          </button>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="message CC…"
          aria-label="message input"
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || text.trim().length === 0}
        >
          Send
        </button>
      </div>
      <span className="input-hint">
        Enter to send · Shift+Enter for newline
      </span>
    </div>
  );
}

