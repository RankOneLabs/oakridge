import type { SessionSnapshot, ResultUsage } from "../types";
import { formatTokens } from "./format";

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

export function resumeTitle(usage: ResultUsage | null): string {
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
