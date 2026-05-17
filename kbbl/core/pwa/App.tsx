import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import type { Task, PermissionProfile } from "../safir/types";
import { PlanReviewView } from "./review/plan/PlanReviewView";
import { BriefReviewView } from "./review/brief/BriefReviewView";
import { Sidebar, type SidebarSession } from "./sidebar/Sidebar";

import type {
  EnvelopeEvent, SessionSnapshot, Theme, ResolutionMap,
  PendingPlanCard, PendingBriefCard, CompactSuggestion, Status,
  PendingMessage, SafirTask, SafirHandoff, TaskFetchState,
  CCUserPayload,
} from "./types";
import { useHashSid } from "./hooks/useHashSid";
import { useHashTaskId } from "./hooks/useHashTaskId";
import { useHashRoute } from "./hooks/useHashRoute";
import { useServerConfig } from "./hooks/useServerConfig";
import { useTheme } from "./hooks/useTheme";
import { useInbox } from "./hooks/useInbox";
import { useInFlightAssistant, turnStartedAtMs } from "./hooks/useInFlightAssistant";
import { useElapsedSeconds } from "./hooks/useElapsedSeconds";
import { generateSlug, sortSessions, toPositiveSafeInt } from "./lib/session";
import { PWA_MODEL_OPTIONS } from "./lib/format";
import { lastMessageEventId, parseSlashCommand } from "./lib/events";
import { NEW_SESSION_MODEL_STORAGE_KEY, readStoredNewSessionModel } from "./lib/storage";

import { SessionRow } from "./components/organisms/SessionRow";
import { MetricsStrip } from "./components/organisms/MetricsStrip";
import { SessionTopBar } from "./components/organisms/SessionTopBar";
import { EventList } from "./components/organisms/EventList";
import { InputBox } from "./components/organisms/InputBox";
import { PendingUserBubble } from "./components/molecules/PendingUserBubble";
import { EndedBanner } from "./components/molecules/EndedBanner";
import { CompactedBanner } from "./components/molecules/CompactedBanner";
import { CompactSuggestionBanner } from "./components/molecules/CompactSuggestionBanner";
import { CompactingBanner } from "./components/molecules/CompactingBanner";
import { InFlightAssistantRow } from "./components/molecules/InFlightAssistantRow";
import { ThinkingIndicator } from "./components/atoms/ThinkingIndicator";

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
