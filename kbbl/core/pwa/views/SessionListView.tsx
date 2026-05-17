import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Task, PermissionProfile } from "../../safir/types";
import { Sidebar, type SidebarSession } from "../sidebar/Sidebar";

import type {
  SessionSnapshot, Theme, PendingPlanCard, PendingBriefCard, Status,
} from "../types";
import { generateSlug, sortSessions, toPositiveSafeInt } from "../lib/session";
import { PWA_MODEL_OPTIONS } from "../lib/format";
import { NEW_SESSION_MODEL_STORAGE_KEY, readStoredNewSessionModel } from "../lib/storage";

import { SessionRow } from "../components/organisms/SessionRow";

export function SessionListView({
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
  const startInFlightRef = useRef(false);
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
    if (startInFlightRef.current) return;
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
    startInFlightRef.current = true;
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
      startInFlightRef.current = false;
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
