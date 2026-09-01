import type { SessionSnapshot } from "../types";

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
export function generateSlug(): string {
  const a = SLUG_ADJ[Math.floor(Math.random() * SLUG_ADJ.length)];
  const n = SLUG_NOUN[Math.floor(Math.random() * SLUG_NOUN.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${a}-${n}-${num}`;
}

export function toPositiveSafeInt(raw: string | null): number | null {
  if (raw === null || !/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function workdirBasename(p: string): string {
  if (!p) return "";
  // Split on both POSIX and Windows separators so a path coming from a
  // Windows operator's worktree (back-slashed) renders as the basename
  // instead of the full path string.
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

export function sessionLabelTitle(snapshot: SessionSnapshot, sid: string): string {
  // Tooltip surface — show full paths (project workdir + worktree path)
  // and the branch so an operator hovering can confirm where edits land
  // without opening DevTools.
  const lines = [snapshot.name];
  if (snapshot.projectWorkdir) lines.push(snapshot.projectWorkdir);
  if (snapshot.worktreePath && snapshot.worktreePath !== snapshot.projectWorkdir) {
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

export function sortSessions(sessions: Map<string, SessionSnapshot>): SessionSnapshot[] {
  // Sort by last activity, newest first. Pending-approval sessions don't
  // float — the pending badge is visible enough, and operators told us
  // they'd rather preserve predictable chronological order.
  return [...sessions.values()].sort((a, b) => {
    if (a.lastActivityTs === b.lastActivityTs) return 0;
    return a.lastActivityTs < b.lastActivityTs ? 1 : -1;
  });
}

export async function resumeSession(
  parentSid: string,
  hydrate: (snap: SessionSnapshot) => void,
  navigate: (sid: string) => void,
): Promise<string | null> {
  try {
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resume_from: parentSid }),
      signal: AbortSignal.timeout(15_000),
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
  } catch (err) {
    return err instanceof Error ? err.message : "network error";
  }
}

export function resumeTitle(): string {
  // Resume = a fresh session in a new worktree cut from this one's, with
  // the parent's committed work carried forward (§17.3). Context/history
  // stays with the agent's own store.
  return "Start a new session in a worktree inheriting this one's work.";
}
