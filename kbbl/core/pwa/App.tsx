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
import { BuildBriefReviewView } from "./review/build-brief/BuildBriefReviewView";


export interface EnvelopeEvent {
  id: number;
  type: string;
  ts: string;
  payload: unknown;
}

type SessionStatus = "starting" | "live" | "compacting" | "ended";

interface ResultUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface SessionSnapshot {
  sid: string;
  name: string;
  workdir: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityTs: string;
  ccSid: string | null;
  parentCcSid: string | null;
  parentOakridgeSid: string | null;
  pendingCount: number;
  yoloMode: boolean;
  allowedTools: string[];
  lastResultUsage: ResultUsage | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeBaseRef: string | null;
  projectWorkdir: string | null;
  model: string | null;
  endReason: "user_closed" | "subprocess_exited" | "compacted" | null;
  successorSid: string | null;
}

const SLUG_ADJ = [
  "amber","azure","brave","bright","calm","clever","cobalt","cozy","crimson",
  "eager","gentle","happy","ivory","jade","kind","lively","mellow","onyx",
  "plucky","quiet","quick","sage","sly","spry","teal","tidy","witty","zesty",
];
const SLUG_NOUN = [
  "badger","cedar","fern","fox","hazel","heron","ivy","juniper","kelp",
  "laurel","lynx","maple","moss","newt","oak","otter","owl","pika","pine",
  "quokka","raven","reed","sumac","tern","thistle","violet","weasel","wren",
];
function generateSlug(): string {
  const a = SLUG_ADJ[Math.floor(Math.random() * SLUG_ADJ.length)];
  const n = SLUG_NOUN[Math.floor(Math.random() * SLUG_NOUN.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${a}-${n}-${num}`;
}

const PWA_MODEL_OPTIONS = [
  { value: "claude-sonnet-4-6", label: "sonnet 4.6" },
  { value: "claude-opus-4-7", label: "opus 4.7" },
  { value: "claude-haiku-4-5-20251001", label: "haiku 4.5" },
  { value: "", label: "default" },
] as const;

function prettyModelLabel(model: string): string {
  return PWA_MODEL_OPTIONS.find((o) => o.value === model)?.label ?? model;
}

function toPositiveSafeInt(raw: string | null): number | null {
  if (raw === null || !/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function workdirBasename(p: string): string {
  if (!p) return "";
  // Split on both POSIX and Windows separators so a path coming from a
  // Windows operator's worktree (back-slashed) renders as the basename
  // instead of the full path string.
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function sessionLabelTitle(snapshot: SessionSnapshot, sid: string): string {
  // Tooltip surface — show full paths (operator workdir + worktree path)
  // and the branch so an operator hovering can confirm where edits land
  // without opening DevTools. Falls back to just workdir for pre-Phase-1
  // sessions, matching the pre-existing tooltip shape.
  const lines = [snapshot.name];
  const project = snapshot.projectWorkdir ?? snapshot.workdir;
  if (project) lines.push(project);
  if (snapshot.worktreePath && snapshot.worktreePath !== project) {
    lines.push(`worktree: ${snapshot.worktreePath}`);
  }
  if (snapshot.worktreeBranch) {
    lines.push(`branch: ${snapshot.worktreeBranch}`);
  }
  if (snapshot.worktreeBaseRef) {
    lines.push(`base: ${snapshot.worktreeBaseRef.slice(0, 12)}`);
  }
  lines.push(`sid ${sid}`);
  return lines.join("\n");
}

type InboxDelta =
  | { type: "session_created"; session: SessionSnapshot }
  | { type: "session_ended"; sid: string }
  | { type: "session_removed"; sid: string }
  | { type: "session_compacted"; sid: string; successor_sid: string }
  | { type: "compact_suggested"; sid: string; tokens: number; reason: string }
  | { type: "status_changed"; sid: string; status: SessionStatus }
  | { type: "pending_count_changed"; sid: string; count: number }
  | { type: "last_activity_changed"; sid: string; ts: string }
  | { type: "yolo_changed"; sid: string; yoloMode: boolean };

type Status = "connecting" | "connected" | "disconnected";
type Theme = "dark" | "light";
type ResolutionMap = Map<string, "allow" | "deny">;

const THEME_STORAGE_KEY = "oakridge.theme";
const NEW_SESSION_MODEL_STORAGE_KEY = "oakridge.newSessionModel";

function readStoredNewSessionModel(): string {
  try {
    const v = localStorage.getItem(NEW_SESSION_MODEL_STORAGE_KEY);
    if (v !== null && PWA_MODEL_OPTIONS.some((o) => o.value === v)) {
      return v;
    }
  } catch {}
  // First-mount default: cost-engineering nudge per the design doc —
  // make sonnet the implicit choice so absent-minded "+ New" clicks
  // route to Sonnet pricing.
  return "claude-sonnet-4-6";
}

function readStoredTheme(): Theme {
  // SSR-safe guard; also swallows SecurityError from sandboxed localStorage.
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "dark";
}

function readHashSid(): string | null {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  return params.get("sid");
}

function writeHashSid(sid: string | null): void {
  if (sid === null) {
    // history.replaceState so hitting Back from a SessionView returns to the
    // prior tab/page rather than chaining through every sid the user viewed.
    history.replaceState(null, "", window.location.pathname + window.location.search);
  } else {
    window.location.hash = `sid=${encodeURIComponent(sid)}`;
  }
}

function useHashSid(): [string | null, (sid: string | null) => void] {
  const [sid, setSid] = useState<string | null>(() => readHashSid());
  useEffect(() => {
    const onHash = () => setSid(readHashSid());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = (next: string | null) => {
    writeHashSid(next);
    setSid(next);
  };
  return [sid, navigate];
}

function readHashTaskId(): number | null {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const raw = params.get("task");
  if (raw === null) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function writeHashTaskId(taskId: number | null): void {
  if (taskId === null) {
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  } else {
    window.location.hash = `task=${taskId}`;
  }
}

function useHashTaskId(): [number | null, (taskId: number | null) => void] {
  const [taskId, setTaskId] = useState<number | null>(() => readHashTaskId());
  useEffect(() => {
    const onHash = () => setTaskId(readHashTaskId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = (next: number | null) => {
    writeHashTaskId(next);
    setTaskId(next);
  };
  return [taskId, navigate];
}

function readHashPlanId(): string | null {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const raw = params.get("plan");
  if (!raw) return null;
  const id = raw.trim();
  return id.length > 0 ? id : null;
}

function writeHashPlanId(id: string | null): void {
  const url = new URL(window.location.href);
  if (id == null) {
    url.hash = "";
  } else {
    url.hash = `plan=${encodeURIComponent(id)}`;
  }
  history.replaceState(null, "", url.toString());
}

function useHashPlanId(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(() => readHashPlanId());
  useEffect(() => {
    const onHash = () => setId(readHashPlanId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = (next: string | null) => {
    writeHashPlanId(next);
    setId(next);
  };
  return [id, navigate];
}

function readHashBriefId(): string | null {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const raw = params.get("brief");
  if (!raw) return null;
  const id = raw.trim();
  return id.length > 0 ? id : null;
}

function writeHashBriefId(id: string | null): void {
  const url = new URL(window.location.href);
  if (id == null) {
    url.hash = "";
  } else {
    url.hash = `brief=${encodeURIComponent(id)}`;
  }
  history.replaceState(null, "", url.toString());
}

function useHashBriefId(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(() => readHashBriefId());
  useEffect(() => {
    const onHash = () => setId(readHashBriefId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = (next: string | null) => {
    writeHashBriefId(next);
    setId(next);
  };
  return [id, navigate];
}

/**
 * Fetches the server's /config once on mount. Returns null until the
 * fetch resolves so callers can render a "loading" placeholder rather
 * than racing forms with empty defaults.
 */
function useServerConfig(): {
  defaultWorkdir: string;
  softThresholdTokens: number;
  safirWebUrl: string;
} | null {
  const [config, setConfig] = useState<{
    defaultWorkdir: string;
    softThresholdTokens: number;
    safirWebUrl: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/config")
      .then((r) => r.json() as Promise<{
        defaultWorkdir: string;
        softThresholdTokens?: number;
        safirWebUrl?: string;
      }>)
      .then((data) => {
        if (!cancelled) setConfig({
          defaultWorkdir: data.defaultWorkdir,
          softThresholdTokens: typeof data.softThresholdTokens === "number"
            ? data.softThresholdTokens
            : 50000,
          safirWebUrl: typeof data.safirWebUrl === "string" && data.safirWebUrl.length > 0
            ? data.safirWebUrl
            : "http://localhost:3000",
        });
      })
      .catch(() => {
        // server may be down or this build is older — leave config null
      });
    return () => { cancelled = true; };
  }, []);
  return config;
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {}
  }, [theme]);
  return [theme, () => setTheme((p) => (p === "dark" ? "light" : "dark"))];
}

interface CompactSuggestion {
  sid: string;
  tokens: number;
}

interface InboxState {
  sessions: Map<string, SessionSnapshot>;
  /**
   * Sids the server currently has in memory (live or ended-but-lingering).
   * Differs from `sessions.keys()` because archived-only entries from the
   * /sessions?include=archived fetch aren't in memory. Used to decide whether
   * a SessionView can open /:sid/stream (in-memory) or must fall back to the
   * one-shot /:sid/events (archived on disk).
   */
  inMemorySids: Set<string>;
  inboxStatus: Status;
  /** Per-session compact suggestions keyed by sid. */
  compactSuggestions: Map<string, CompactSuggestion>;
  /** Optimistically clear the suggestion for a given sid. */
  clearCompactSuggestion: (sid: string) => void;
  /**
   * Fold a snapshot we already have in hand (e.g. the response body of
   * POST /sessions) into the inbox state so the destination view mounts
   * with the correct snapshot instead of racing the /inbox delta. Safe
   * to call before /inbox actually delivers session_created — the delta
   * just re-seats the same entry.
   */
  hydrateSession: (snapshot: SessionSnapshot) => void;
}

function useInbox(opts: { onSessionRemoved?: (sid: string) => void } = {}): InboxState {
  const [sessions, setSessions] = useState<Map<string, SessionSnapshot>>(
    () => new Map(),
  );
  const [inMemorySids, setInMemorySids] = useState<Set<string>>(
    () => new Set(),
  );
  const [inboxStatus, setInboxStatus] = useState<Status>("connecting");
  const [compactSuggestions, setCompactSuggestions] = useState<Map<string, CompactSuggestion>>(() => new Map());
  // Mirror onSessionRemoved into a ref so the EventSource handler (set up
  // once on mount) reads the latest closure on each delta — otherwise it
  // would call a stale callback that captured the initial render's sid.
  // Assign during render rather than in a passive useEffect so there's no
  // window between a re-render and the effect firing where a delta could
  // hit the previous callback. Mutating a ref during render is sanctioned
  // by the React docs for exactly this "always-fresh callback" pattern.
  const onSessionRemovedRef = useRef(opts.onSessionRemoved);
  onSessionRemovedRef.current = opts.onSessionRemoved;

  const hydrateSession = useCallback((snapshot: SessionSnapshot) => {
    setSessions((prev) => {
      const next = new Map(prev);
      next.set(snapshot.sid, snapshot);
      return next;
    });
    setInMemorySids((prev) => {
      if (prev.has(snapshot.sid)) return prev;
      const next = new Set(prev);
      next.add(snapshot.sid);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Seed with the full list (in-memory + archived). The inbox snapshot
    // that arrives below will overwrite in-memory entries with fresher
    // copies; archived-only entries carry over untouched.
    fetch("/sessions?include=archived")
      .then((r) => r.json() as Promise<{ sessions: SessionSnapshot[] }>)
      .then((data) => {
        if (cancelled) return;
        setSessions((prev) => {
          const next = new Map(prev);
          for (const s of data.sessions) {
            if (!next.has(s.sid)) next.set(s.sid, s);
          }
          return next;
        });
        // Seed inMemorySids with every non-ended sid so SessionView picks
        // /:sid/stream (SSE) over one-shot /:sid/events when the user
        // clicks a live session before the /inbox SSE has connected. Only
        // non-ended sids: archived-on-disk entries (always status=ended)
        // would otherwise be incorrectly marked as in-memory.
        setInMemorySids((prev) => {
          const next = new Set(prev);
          for (const s of data.sessions) {
            if (s.status !== "ended") next.add(s.sid);
          }
          return next;
        });
      })
      .catch(() => {
        // Network error; the inbox subscription below still provides live
        // state, it just won't show prior-run archived sessions.
      });

    const es = new EventSource("/inbox");
    es.onopen = () => setInboxStatus("connected");
    es.onerror = () => setInboxStatus("disconnected");
    es.addEventListener("snapshot", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        sessions: SessionSnapshot[];
      };
      setSessions((prev) => {
        const next = new Map(prev);
        for (const s of data.sessions) next.set(s.sid, s);
        return next;
      });
      setInMemorySids(new Set(data.sessions.map((s) => s.sid)));
    });
    es.addEventListener("delta", (e) => {
      const delta = JSON.parse((e as MessageEvent).data) as InboxDelta;
      setSessions((prev) => applyDelta(prev, delta));
      if (delta.type === "session_created") {
        setInMemorySids((prev) => {
          if (prev.has(delta.session.sid)) return prev;
          const next = new Set(prev);
          next.add(delta.session.sid);
          return next;
        });
      }
      if (delta.type === "session_removed") {
        setInMemorySids((prev) => {
          if (!prev.has(delta.sid)) return prev;
          const next = new Set(prev);
          next.delete(delta.sid);
          return next;
        });
        // Fire the consumer callback AFTER state setters so a navigate(null)
        // it triggers lands on the same React batch as the map drop.
        onSessionRemovedRef.current?.(delta.sid);
      }
      // session_ended keeps the sid in inMemorySids: ended sessions linger
      // in the manager map (and stream/events still work against them)
      // until the server process exits. session_removed (purge) is what
      // actually drops the entry.
      if (delta.type === "compact_suggested") {
        setCompactSuggestions((prev) => {
          const next = new Map(prev);
          next.set(delta.sid, { sid: delta.sid, tokens: delta.tokens });
          return next;
        });
      }
      if (
        delta.type === "status_changed" &&
        (delta.status === "compacting" || delta.status === "ended")
      ) {
        setCompactSuggestions((prev) => {
          if (!prev.has(delta.sid)) return prev;
          const next = new Map(prev);
          next.delete(delta.sid);
          return next;
        });
      }
      if (delta.type === "session_ended") {
        setCompactSuggestions((prev) => {
          if (!prev.has(delta.sid)) return prev;
          const next = new Map(prev);
          next.delete(delta.sid);
          return next;
        });
      }
      if (delta.type === "session_compacted") {
        setCompactSuggestions((prev) => {
          if (!prev.has(delta.sid)) return prev;
          const next = new Map(prev);
          next.delete(delta.sid);
          return next;
        });
      }
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  const clearCompactSuggestion = useCallback((sid: string) => {
    setCompactSuggestions((prev) => {
      if (!prev.has(sid)) return prev;
      const next = new Map(prev);
      next.delete(sid);
      return next;
    });
  }, []);
  return { sessions, inMemorySids, inboxStatus, compactSuggestions, clearCompactSuggestion, hydrateSession };
}

function applyDelta(
  prev: Map<string, SessionSnapshot>,
  delta: InboxDelta,
): Map<string, SessionSnapshot> {
  const next = new Map(prev);
  switch (delta.type) {
    case "session_created":
      next.set(delta.session.sid, delta.session);
      break;
    case "session_ended": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, status: "ended", pendingCount: 0 });
      break;
    }
    case "session_removed": {
      next.delete(delta.sid);
      break;
    }
    case "session_compacted": {
      const s = next.get(delta.sid);
      // Ordering: finalize() emits status_changed("ended"), then onEnded
      // broadcasts session_ended, then abort() resolves and session_compacted
      // is broadcast. By the time this case runs, status is already "ended".
      // Patch in endReason + successorSid so CompactedBanner has the data it
      // needs without waiting for a snapshot refetch. If the predecessor isn't
      // in the map (rare race during initial /sessions hydration), the next
      // snapshot fetch carries the same fields from disk.
      if (s) {
        next.set(delta.sid, {
          ...s,
          endReason: "compacted",
          successorSid: delta.successor_sid,
        });
      }
      break;
    }
    case "status_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, status: delta.status });
      break;
    }
    case "pending_count_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, pendingCount: delta.count });
      break;
    }
    case "last_activity_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, lastActivityTs: delta.ts });
      break;
    }
    case "yolo_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, yoloMode: delta.yoloMode });
      break;
    }
  }
  return next;
}

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
  const [sid, navigate] = useHashSid();
  const [taskId, navigateTask] = useHashTaskId();
  const [planId, navigatePlan] = useHashPlanId();
  const [briefId, navigateBrief] = useHashBriefId();
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
  if (planId !== null) {
    return (
      <PlanReviewView
        planId={planId}
        onBack={() => navigatePlan(null)}
      />
    );
  }
  if (briefId !== null) {
    return (
      <BuildBriefReviewView
        briefId={briefId}
        onBack={() => navigateBrief(null)}
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
      onSelectBrief={(id) => navigateBrief(id)}
      onSelectPlan={(id) => navigatePlan(id)}
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
  onSelectBrief,
  onSelectPlan,
}: {
  sessions: Map<string, SessionSnapshot>;
  inboxStatus: Status;
  theme: Theme;
  defaultWorkdir: string;
  onToggleTheme: () => void;
  onSelect: (sid: string) => void;
  onHydrateSession: (snapshot: SessionSnapshot) => void;
  onSelectBrief: (briefId: string) => void;
  onSelectPlan: (planId: string) => void;
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
  const [pendingPlans, setPendingPlans] = useState<Array<{ id: string; summary: string | null; status: string }>>([]);
  const [pendingBriefs, setPendingBriefs] = useState<Array<{ id: string; goal: string | null; status: string }>>([]);
  const [autostartPending, setAutostartPending] = useState(false);
  const profileLockedRef = useRef(false);
  const sorted = useMemo(() => sortSessions(sessions), [sessions]);

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
    void (async () => {
      try {
        const res = await fetch("/safir/build-briefs?status=pending_approval");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Array<{ id: string; goal: string | null; status: string }>;
        if (cancelled) return;
        setPendingBriefs(data);
      } catch (err) { console.error("fetch pending briefs failed:", err); }
    })();
    void (async () => {
      try {
        const res = await fetch("/safir/plans?status=pending_approval");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Array<{ id: string; summary: string | null; status: string }>;
        if (cancelled) return;
        setPendingPlans(data);
      } catch (err) { console.error("fetch pending plans failed:", err); }
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

  return (
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
        <div className="pending-plans">
          <div className="pending-plans-header">
            pending plans ({pendingPlans.length})
          </div>
          <ul className="pending-plans-list">
            {pendingPlans.map((p) => (
              <li key={p.id} className="pending-plan-row">
                <button
                  type="button"
                  className="pending-plan-btn"
                  onClick={() => onSelectPlan(p.id)}
                >
                  <span className="pending-plan-summary">{p.summary ?? "(no summary)"}</span>
                  <span className="pending-plan-id">{p.id.slice(0, 8)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pendingBriefs.length > 0 && (
        <div className="pending-briefs">
          <div className="pending-briefs-header">
            pending build briefs ({pendingBriefs.length})
          </div>
          <ul className="pending-briefs-list">
            {pendingBriefs.map((b) => (
              <li key={b.id} className="pending-brief-row">
                <button
                  type="button"
                  className="pending-brief-btn"
                  onClick={() => onSelectBrief(b.id)}
                >
                  <span className="pending-brief-goal">{b.goal ?? "(no goal)"}</span>
                  <span className="pending-brief-id">{b.id.slice(0, 8)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
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
  );
}

function sortSessions(sessions: Map<string, SessionSnapshot>): SessionSnapshot[] {
  // Sort by last activity, newest first. Pending-approval sessions don't
  // float — the pending badge is visible enough, and operators told us
  // they'd rather preserve predictable chronological order.
  return [...sessions.values()].sort((a, b) => {
    if (a.lastActivityTs === b.lastActivityTs) return 0;
    return a.lastActivityTs < b.lastActivityTs ? 1 : -1;
  });
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

function resumeTitle(usage: ResultUsage | null): string {
  if (!usage) {
    return "Start a new session inheriting this one's context.";
  }
  // Cache reads are ~free; cache_creation is what a resume re-ingests as
  // new context on Claude Max, so include it in the rough "cost" number.
  // This is a ballpark — CC's internal tokenization + prompt scaffolding
  // add overhead we can't see from the result event alone.
  const rough =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.output_tokens;
  return (
    `Start a new session inheriting this one's context.\n` +
    `~${formatTokens(rough)} parent context — ` +
    `on Claude Max this burns against the 5-hour rate-limit window, not dollars.`
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tokens`;
  return `${(n / 1_000_000).toFixed(1)}M tokens`;
}

function useRelativeTime(iso: string): string {
  // Re-render once per minute so "2m ago" doesn't get stale. A 60s tick is
  // coarse enough to stay off the render hot path but fine-grained enough
  // that operators see the list refresh before the data feels wrong.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return formatRelative(iso);
}

function formatRelative(iso: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const deltaSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  // Floor rather than round for the larger unit conversions — a 1m30s-old
  // session showing as "2m ago" overstates the elapsed time. Labels
  // advance only once the next threshold is actually crossed.
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Module-scope formatter so the hover tooltip is locale-stable (seconds and
// time zone always present) and we don't spin up a new Intl instance per
// timestamp render. Use granular options because ECMA-402 forbids combining
// dateStyle/timeStyle with timeZoneName.
const exactTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});
function formatExactTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return exactTimeFormatter.format(t);
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

// Find the id of the last event that renders as a textual message bubble (a
// user string or an assistant text block). Tool calls, results, system
// notices, etc. are skipped. Used to pin a timestamp to the bottom-most
// message only — every-message timestamps drown the transcript.
function lastMessageEventId(events: EnvelopeEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "user") {
      const p = e.payload as CCUserPayload & { isSynthetic?: boolean };
      const content = p.message?.content;
      // Synthetic users (post-compact summaries, skill bodies) and
      // <local-command-stdout> wrappers don't render a normal bubble, so
      // they shouldn't claim the "latest" timestamp slot — that would
      // strand the timestamp on an invisible row.
      if (
        p.isSynthetic !== true &&
        typeof content === "string" &&
        parseLocalCommandStdout(content) === null
      ) {
        return e.id;
      }
    } else if (e.type === "assistant") {
      const p = e.payload as CCAssistantPayload;
      const blocks = p.message?.content ?? [];
      if (blocks.some((b) => b.type === "text")) return e.id;
    }
  }
  return null;
}

// Returns ms-since-epoch for an ISO timestamp, or null if Date.parse fails.
// Stream events flow from the network and a malformed ts would otherwise
// poison the elapsed-timer math (NaN propagates through arithmetic and
// nullish-coalescing to never-render NaN).
function parseIsoMs(s: string): number | null {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// Reconstructs a live partial assistant message from --include-partial-messages
// stream_event records. CC emits an Anthropic-style sequence: message_start →
// content_block_start (per block) → content_block_delta (many) →
// content_block_stop → message_delta → message_stop.
//
// Built incrementally: a useRef accumulator advances as new events append to
// the array, so a long stream stays O(N) overall instead of O(N²) (each
// useMemo run previously rescanned the entire post-`result` window). Block
// updates are immutable — `blocks.set(idx, { ...block, text: block.text + ... })`
// — so cached prior renders can't be mutated by a future delta under React
// Strict Mode or the React Compiler.
interface InFlightAssistant {
  blocks: ContentBlock[];
  outputTokens: number | null;
  startedAt: number;
}

interface InFlightAccum {
  blocks: Map<number, ContentBlock>;
  // Per-block-index accumulator for `input_json_delta` chunks. Anthropic
  // streams tool_use inputs as concatenated partial JSON; we buffer the
  // string and parse opportunistically so the live panel can preview the
  // call (Bash command, file path, etc.) before the turn closes.
  partialToolInputs: Map<number, string>;
  outputTokens: number | null;
  startedAtMs: number | null;
  lastEventIdx: number;
  sid: string;
}

function emptyAccum(sid: string): InFlightAccum {
  return {
    blocks: new Map(),
    partialToolInputs: new Map(),
    outputTokens: null,
    startedAtMs: null,
    lastEventIdx: -1,
    sid,
  };
}

function snapshotAccum(a: InFlightAccum): InFlightAssistant | null {
  if (a.blocks.size === 0 && a.outputTokens === null) return null;
  const ordered = [...a.blocks.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, v]) => v);
  return {
    blocks: ordered,
    outputTokens: a.outputTokens,
    startedAt: a.startedAtMs ?? Date.now(),
  };
}

function useInFlightAssistant(
  events: EnvelopeEvent[],
  sid: string,
): InFlightAssistant | null {
  const [value, setValue] = useState<InFlightAssistant | null>(null);
  const accumRef = useRef<InFlightAccum>(emptyAccum(sid));

  useEffect(() => {
    const a = accumRef.current;
    if (a.sid !== sid) {
      accumRef.current = emptyAccum(sid);
      setValue(null);
      return;
    }
    let dirty = false;
    for (let i = a.lastEventIdx + 1; i < events.length; i++) {
      const evt = events[i];
      // Turn boundary: clear so the canonical AssistantRow takes over once
      // the final assistant event lands, and reset for the next user turn
      // when a `result` arrives.
      if (evt.type === "result" || evt.type === "assistant") {
        if (
          a.blocks.size > 0 ||
          a.outputTokens !== null ||
          a.startedAtMs !== null
        ) {
          a.blocks = new Map();
          a.partialToolInputs = new Map();
          a.outputTokens = null;
          a.startedAtMs = null;
          dirty = true;
        }
        continue;
      }
      if (evt.type !== "stream_event") continue;
      // Capture the turn-start timestamp on the first stream_event of the
      // current turn (turn-boundary reset above clears startedAtMs). Doing
      // this at the top of the stream_event branch — instead of only inside
      // the message_start handler — covers two edge cases: a late-joining
      // SSE viewer who missed message_start, and a stream that opens with
      // content_block_start (CC has been observed to do this with cached
      // prefixes). It also keeps the start-time scoped to the current turn,
      // so a malformed ts can't snap the elapsed counter to a historical
      // event from a previous turn.
      if (a.startedAtMs === null) {
        const ms = parseIsoMs(evt.ts);
        if (ms !== null) {
          a.startedAtMs = ms;
          dirty = true;
        }
      }
      const wrapped = evt.payload as { event?: unknown };
      const e = wrapped?.event as
        | {
            type?: string;
            index?: number;
            message?: { usage?: { output_tokens?: unknown } };
            content_block?: {
              type?: string;
              id?: unknown;
              name?: unknown;
              input?: unknown;
              text?: unknown;
              thinking?: unknown;
            };
            delta?: {
              type?: string;
              text?: unknown;
              thinking?: unknown;
              partial_json?: unknown;
            };
            usage?: { output_tokens?: unknown };
          }
        | undefined;
      if (!e || typeof e.type !== "string") continue;
      if (e.type === "message_start") {
        const ot = e.message?.usage?.output_tokens;
        if (typeof ot === "number") a.outputTokens = ot;
        dirty = true;
      } else if (e.type === "content_block_start") {
        const idx = e.index;
        const cb = e.content_block;
        if (typeof idx !== "number" || !cb || typeof cb.type !== "string") {
          continue;
        }
        if (cb.type === "text") {
          a.blocks.set(idx, {
            type: "text",
            text: typeof cb.text === "string" ? cb.text : "",
          });
          dirty = true;
        } else if (cb.type === "thinking") {
          a.blocks.set(idx, {
            type: "thinking",
            thinking: typeof cb.thinking === "string" ? cb.thinking : "",
          });
          dirty = true;
        } else if (cb.type === "tool_use") {
          a.blocks.set(idx, {
            type: "tool_use",
            id: typeof cb.id === "string" ? cb.id : "",
            name: typeof cb.name === "string" ? cb.name : "",
            input: cb.input ?? {},
          });
          dirty = true;
        }
      } else if (e.type === "content_block_delta") {
        const idx = e.index;
        const d = e.delta;
        if (typeof idx !== "number" || !d || typeof d.type !== "string") {
          continue;
        }
        let block = a.blocks.get(idx);
        if (!block) {
          // Late-join: an SSE reconnect can land us mid-stream after the
          // matching content_block_start has already been delivered to
          // earlier subscribers. Synthesize an empty block of the right
          // kind from the delta type so the partial UI keeps rendering
          // instead of silently dropping every chunk.
          if (d.type === "text_delta") block = { type: "text", text: "" };
          else if (d.type === "thinking_delta") {
            block = { type: "thinking", thinking: "" };
          } else if (d.type === "input_json_delta") {
            block = { type: "tool_use", id: "", name: "", input: {} };
          } else continue;
          a.blocks.set(idx, block);
        }
        if (
          d.type === "text_delta" &&
          block.type === "text" &&
          typeof d.text === "string"
        ) {
          a.blocks.set(idx, { ...block, text: block.text + d.text });
          dirty = true;
        } else if (
          d.type === "thinking_delta" &&
          block.type === "thinking" &&
          typeof d.thinking === "string"
        ) {
          a.blocks.set(idx, {
            ...block,
            thinking: block.thinking + d.thinking,
          });
          dirty = true;
        } else if (
          d.type === "input_json_delta" &&
          block.type === "tool_use" &&
          typeof d.partial_json === "string"
        ) {
          // Buffer the partial-JSON chunks per block index. JSON.parse
          // only succeeds once the chunks accumulate to a complete value,
          // so for the first several deltas we silently keep accumulating
          // and the live panel just shows the tool name. Once parseable,
          // the parsed object replaces the block's input — previewToolInput
          // can now show e.g. "Bash" + "npm test" before the turn closes.
          //
          // Only attempt parse when the buffer ends with `}` or `]` — the
          // outermost terminator of a JSON object or array value, which is
          // what tool inputs always are. Without this gate, every chunk
          // re-parses the full accumulated string (O(N×M)); large Write
          // contents would noticeably stall the UI thread mid-stream.
          const prev = a.partialToolInputs.get(idx) ?? "";
          const next = prev + d.partial_json;
          a.partialToolInputs.set(idx, next);
          const last = next.charCodeAt(next.length - 1);
          if (last === 0x7d /* } */ || last === 0x5d /* ] */) {
            try {
              a.blocks.set(idx, { ...block, input: JSON.parse(next) });
            } catch {
              // brace inside a string value, not the outermost close;
              // keep accumulating
            }
          }
          dirty = true;
        }
      } else if (e.type === "message_delta") {
        const ot = e.usage?.output_tokens;
        if (typeof ot === "number") {
          a.outputTokens = ot;
          dirty = true;
        }
      }
    }
    a.lastEventIdx = events.length - 1;
    if (dirty) setValue(snapshotAccum(a));
  }, [events, sid]);

  return value;
}

// Timestamp of the first event after the most recent `result` — drives the
// elapsed counter even before CC's first stream_event arrives. Returns null
// for a malformed ts so NaN doesn't reach the elapsed math.
function turnStartedAtMs(
  events: EnvelopeEvent[],
  awaitingResult: boolean,
): number | null {
  if (!awaitingResult) return null;
  let lastResultIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "result") {
      lastResultIdx = i;
      break;
    }
  }
  for (let i = lastResultIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (
      e.type === "user" ||
      e.type === "assistant" ||
      e.type === "stream_event"
    ) {
      return parseIsoMs(e.ts);
    }
  }
  return null;
}

// 1Hz tick while `active` so derived elapsed-time UI re-renders without
// polluting unrelated state.
function useElapsedSeconds(
  startedAtMs: number | null,
  active: boolean,
): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (startedAtMs === null) return null;
  return Math.max(0, Math.floor((now - startedAtMs) / 1000));
}

function formatElapsedSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

// === session view ===

interface PendingMessage {
  localId: number;
  text: string;
  sentAt: number;
}

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

interface SessionMetrics {
  turns: number;
  totalIn: number;
  totalOut: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  totalCost: number;
  totalDur: number;
  last: {
    inT: number;
    outT: number;
    cacheRead: number;
    cacheCreate: number;
    dur: number;
    cost: number;
  } | null;
}

function computeMetrics(events: EnvelopeEvent[]): SessionMetrics {
  const m: SessionMetrics = {
    turns: 0,
    totalIn: 0,
    totalOut: 0,
    totalCacheRead: 0,
    totalCacheCreate: 0,
    totalCost: 0,
    totalDur: 0,
    last: null,
  };
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  for (const e of events) {
    if (e.type !== "result") continue;
    const p = e.payload as Record<string, unknown>;
    const usage = (p.usage as Record<string, unknown> | undefined) ?? {};
    const inT = num(usage.input_tokens);
    const outT = num(usage.output_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheCreate = num(usage.cache_creation_input_tokens);
    const dur = num(p.duration_ms);
    const cost = num(p.total_cost_usd);
    m.turns++;
    m.totalIn += inT;
    m.totalOut += outT;
    m.totalCacheRead += cacheRead;
    m.totalCacheCreate += cacheCreate;
    m.totalCost += cost;
    m.totalDur += dur;
    m.last = { inT, outT, cacheRead, cacheCreate, dur, cost };
  }
  return m;
}

function fmtTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtDuration(ms: number): string {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Round to total seconds first, then split — splitting independently lets
  // the seconds round up to 60 and produce strings like "1m60s".
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m${secs.toString().padStart(2, "0")}s`;
}

function fmtCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
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

type ListItem =
  | { kind: "event"; event: EnvelopeEvent }
  | { kind: "tool_batch"; events: EnvelopeEvent[]; firstId: number }
  | {
      kind: "compact";
      startEvent: EnvelopeEvent;
      doneEvent: EnvelopeEvent | null;
    };

interface SystemStatusPayload {
  subtype?: string;
  status?: string | null;
  compact_result?: string;
}

function isCompactStartEvent(e: EnvelopeEvent): boolean {
  if (e.type !== "system") return false;
  const p = e.payload as SystemStatusPayload | null;
  return p?.subtype === "status" && p.status === "compacting";
}

function isCompactDoneEvent(e: EnvelopeEvent): boolean {
  if (e.type !== "system") return false;
  const p = e.payload as SystemStatusPayload | null;
  return (
    p?.subtype === "status" &&
    p.status === null &&
    typeof p.compact_result === "string"
  );
}

// Consecutive tool_use / tool_result events get folded into a single
// collapsible "N tool calls" section so a YOLO-mode turn that fires 20 file
// reads doesn't blow the transcript out vertically. A non-tool event (text
// reply, an unresolved permission card, a real system notice) breaks the
// batch and renders inline.
function isToolOnlyEvent(e: EnvelopeEvent): boolean {
  if (e.type === "assistant") {
    const p = e.payload as CCAssistantPayload;
    const blocks = p.message?.content ?? [];
    if (blocks.length === 0) return false;
    return blocks.every((b) => b.type === "tool_use");
  }
  if (e.type === "user") {
    const p = e.payload as CCUserPayload;
    const content = p.message?.content;
    if (!Array.isArray(content) || content.length === 0) return false;
    return content.every((b) => b.type === "tool_result");
  }
  return false;
}

function isFilteredEvent(
  e: EnvelopeEvent,
  resolutions: ResolutionMap,
  showSystemEvents: boolean,
): boolean {
  // Mirrors what EventRow returns null for, so batching doesn't accidentally
  // break across an event that wouldn't have rendered anyway.
  if (e.type === "permission_resolved") return true;
  // Hard-filter stream_event independent of showSystemEvents — the partial-
  // message deltas are reconstructed by InFlightAssistantRow, never as a row.
  // Without this, "show system events" would flood the transcript with one
  // chunk per token during long generations.
  if (e.type === "stream_event") return true;
  if (showSystemEvents) return false;
  if (isLowSignalEvent(e)) return true;
  if (e.type === "permission_auto_approved" || e.type === "permission_auto_denied") return true;
  if (e.type === "permission_request") {
    const p = e.payload as PermissionRequestPayload;
    return resolutions.has(p.request_id);
  }
  return false;
}

interface SafirTask {
  id: number;
  project_id: string;
  parent_id: number | null;
  title: string;
  status: string;
}

interface SafirHandoff {
  id: string;
  phase_id: string | null;
  run_id: string | null;
  role: "phase_output" | "run_brief";
  schema_version: number;
  goal: string | null;
  next_action: string | null;
  raw_markdown: string;
  produced_at: string;
}

type TaskFetchState =
  | { kind: "loading" }
  | { kind: "ok"; task: SafirTask; handoffs: SafirHandoff[] }
  | { kind: "not_found" }
  | { kind: "safir_down" }
  | { kind: "error"; status: number; message: string };

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

function buildListItems(
  events: EnvelopeEvent[],
  resolutions: ResolutionMap,
  showSystemEvents: boolean,
): ListItem[] {
  const items: ListItem[] = [];
  let batch: EnvelopeEvent[] = [];
  const flush = () => {
    if (batch.length > 0) {
      items.push({ kind: "tool_batch", events: batch, firstId: batch[0].id });
      batch = [];
    }
  };
  for (const e of events) {
    // Compact-status events are operator-actionable signal regardless of
    // showSystemEvents — fold the start+done pair into a single live pill.
    if (isCompactStartEvent(e)) {
      flush();
      items.push({ kind: "compact", startEvent: e, doneEvent: null });
      continue;
    }
    if (isCompactDoneEvent(e)) {
      let attached = false;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "compact" && it.doneEvent === null) {
          it.doneEvent = e;
          attached = true;
          break;
        }
      }
      if (attached) continue;
    }
    if (isFilteredEvent(e, resolutions, showSystemEvents)) continue;
    if (isToolOnlyEvent(e)) {
      batch.push(e);
    } else {
      flush();
      items.push({ kind: "event", event: e });
    }
  }
  flush();
  return items;
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

interface ToolUseEntry {
  id: string;
  name: string;
  input: unknown;
  eventId: number;
}
interface ToolResultEntry {
  content: unknown;
  isError: boolean;
  eventId: number;
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

function summarizeToolNames(names: string[]): string {
  // Group runs of the same tool: ["Read","Read","Bash"] -> "Read×2, Bash"
  const groups: Array<{ name: string; count: number }> = [];
  for (const n of names) {
    const last = groups[groups.length - 1];
    if (last && last.name === n) last.count++;
    else groups.push({ name: n, count: 1 });
  }
  return groups
    .map((g) => (g.count > 1 ? `${g.name}×${g.count}` : g.name))
    .join(", ");
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
function previewToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const pick = (k: string): string | null =>
    typeof i[k] === "string" ? (i[k] as string) : null;
  let raw: string | null = null;
  switch (name) {
    case "Bash":
      raw = pick("command");
      break;
    case "Read":
    case "Write":
    case "NotebookEdit":
      raw = pick("file_path");
      break;
    case "Edit":
      raw = pick("file_path");
      break;
    case "Glob":
      raw = pick("pattern");
      break;
    case "Grep":
      raw = pick("pattern");
      break;
    case "WebFetch":
    case "WebSearch":
      raw = pick("url") ?? pick("query");
      break;
    case "TodoWrite":
      raw = "(todo list)";
      break;
  }
  if (!raw) raw = JSON.stringify(input);
  return raw.length > 90 ? raw.slice(0, 90) + "…" : raw;
}

// Compact-mode hides the chatter that surfaces because we run CC with
// --include-hook-events plus the bookkeeping the gate emits as it
// resolves, plus per-turn lifecycle events that don't carry operator-
// actionable info. The signal is the assistant turn + tool_use/tool_result;
// the rest is plumbing.
function isLowSignalEvent(event: EnvelopeEvent): boolean {
  switch (event.type) {
    case "tool_allowlisted":
    case "session_started":
    case "result":
      return true;
    case "system":
      // CC emits `system` for init, hook_started, hook_response, etc.
      // None of these are operator-actionable; the transcript already
      // shows the work happening via assistant/tool events.
      return true;
    case "stream_event":
      // Partial-message deltas from --include-partial-messages. The
      // InFlightAssistantRow renders the reconstructed message; the raw
      // per-chunk events would just be transcript noise.
      return true;
    case "usage_observation":
      // Per-turn cache-vs-idle telemetry (kbbl/core/session/session.ts).
      // Phase 6.2 will consume these for the cost panel; until then,
      // hiding them keeps the transcript clean during the baseline soak.
      return true;
    default:
      return false;
  }
}

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

interface CCUserPayload {
  message?: { role?: string; content?: string | ContentBlock[] };
}
interface CCAssistantPayload {
  message?: { content?: ContentBlock[] };
}
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      // Anthropic's tool_result block technically allows structured content
      // (text blocks, image blocks) in addition to plain strings. CC's CLI
      // emits strings today but typing this as `unknown` lets the renderer
      // handle both without a future schema drift breaking the UI.
      content: unknown;
      is_error?: boolean;
    };

// CC expands a `/foo bar` invocation into a giant blob that begins with
// `<command-message>`, `<command-name>`, `<command-args>` and then the full
// skill body. Rendered raw it dominates the transcript; collapse it to a
// single chip showing the invocation, with the full body one tap away.
function parseSlashCommand(
  text: string,
): { name: string; args: string } | null {
  if (!text.startsWith("<command-")) return null;
  const nameMatch = text.match(/<command-name>\s*\/?([^<]*)<\/command-name>/);
  if (!nameMatch) return null;
  const argsMatch = text.match(/<command-args>([^<]*)<\/command-args>/);
  return {
    name: nameMatch[1].trim(),
    args: argsMatch ? argsMatch[1].trim() : "",
  };
}

// CC re-injects local command output (e.g. a leading `!` bash invocation)
// as a synthetic user message wrapped in <local-command-stdout>…</local-
// command-stdout>. Rendered raw it looks like an operator typed the output;
// collapse to a single system pill so the transcript doesn't lie about who
// produced the bytes.
function parseLocalCommandStdout(text: string): string | null {
  if (!text.startsWith("<local-command-stdout>")) return null;
  const m = text.match(
    /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/,
  );
  return m ? m[1] : null;
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

interface PermissionRequestPayload {
  request_id: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
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

function formatResultText(p: Record<string, unknown>): string {
  const dur = typeof p.duration_ms === "number" ? p.duration_ms : null;
  const cost = typeof p.total_cost_usd === "number" ? p.total_cost_usd : null;
  const usage = (p.usage as Record<string, unknown> | undefined) ?? {};
  const inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outTok =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const parts: string[] = ["turn complete"];
  if (dur !== null) parts.push(`${(dur / 1000).toFixed(1)}s`);
  if (inTok || outTok) parts.push(`${inTok}→${outTok} tok`);
  if (cost !== null && cost > 0) parts.push(`$${cost.toFixed(4)}`);
  return parts.join(" · ");
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

