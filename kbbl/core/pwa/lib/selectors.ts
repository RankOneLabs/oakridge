import type { Sid } from "./ids";
import { sortSessions } from "./session";
import type { AppState } from "../state/store";
import type {
  CompactSuggestion,
  PendingBriefCard,
  PendingPlanCard,
  SessionSnapshot,
  Status,
} from "../types";

/**
 * Sorted session list — newest activity first. Consumed by the session
 * list AND by the sidebar mapping that derives SidebarSession entries
 * from it. Wraps the existing pure helper in lib/session.ts so callers
 * can pull from the store without importing both modules.
 */
export function selectSortedSessions(
  sessions: Map<Sid, SessionSnapshot>,
): SessionSnapshot[] {
  return sortSessions(sessions as Map<string, SessionSnapshot>);
}

/**
 * Sidebar projection: the minimal subset of SessionSnapshot the sidebar
 * needs. projectWorkdir wins over workdir (worktree-backed sessions live
 * under /tmp/.../worktrees/<branch>; projectWorkdir is the canonical
 * repo path the sidebar groups by). Pre-Phase-1 sessions without a
 * projectWorkdir fall back to workdir.
 */
export interface SidebarSessionProjection {
  sid: string;
  name: string;
  workdir: string;
  status: string;
}

export function selectSidebarSessions(
  sorted: SessionSnapshot[],
): SidebarSessionProjection[] {
  return sorted.map((s) => ({
    sid: s.sid,
    name: s.name,
    workdir: s.projectWorkdir ?? s.workdir,
    status: s.status,
  }));
}

/**
 * Composite SessionView needs for a single sid: snapshot (or null if not
 * loaded), whether the server still has it in memory, the current inbox
 * status, and any compact suggestion. Reads from the store via a single
 * pass — components that prefer slice-selectors can still call
 * useStore(s => s.sessions.get(sid as Sid)) individually.
 */
export interface SessionViewBundle {
  snapshot: SessionSnapshot | null;
  inMemory: boolean;
  inboxStatus: Status;
  compactSuggestion: CompactSuggestion | null;
}

export function selectSessionView(
  state: Pick<
    AppState,
    "sessions" | "inMemorySids" | "inboxStatus" | "compactSuggestions"
  >,
  sid: Sid,
): SessionViewBundle {
  return {
    snapshot: state.sessions.get(sid) ?? null,
    inMemory: state.inMemorySids.has(sid),
    inboxStatus: state.inboxStatus,
    compactSuggestion: state.compactSuggestions.get(sid) ?? null,
  };
}

/**
 * Aggregate count of pending plan + brief reviews. The SessionListView
 * header surfaces the section when count > 0; future badges and the
 * sidebar review chip read the same shape.
 */
export function selectPendingReviewsCount(
  plans: PendingPlanCard[],
  briefs: PendingBriefCard[],
): number {
  return plans.length + briefs.length;
}

/** One session with at least one parked tool-approval. */
export interface ApprovalWaiter {
  sid: string;
  name: string;
  pendingCount: number;
}

/**
 * Sessions with at least one pending tool-approval, newest-activity first.
 * Powers the global approval badge so a parked approval is visible from any
 * view — not only inside that session's own conversation, where it would
 * otherwise sit unseen until CC's permission hook times out. pendingCount is
 * reset to 0 when a session ends, so a positive count already implies the
 * session is live and actionable; we still drop "ended" defensively.
 */
export function selectSessionsAwaitingApproval(
  sessions: SessionSnapshot[],
): ApprovalWaiter[] {
  return sessions
    .filter((s) => s.pendingCount > 0 && s.status !== "ended")
    .sort((a, b) => Date.parse(b.lastActivityTs) - Date.parse(a.lastActivityTs))
    .map((s) => ({ sid: s.sid, name: s.name, pendingCount: s.pendingCount }));
}

/** Total parked tool-approvals across all live sessions (the badge count). */
export function selectPendingApprovalCount(sessions: SessionSnapshot[]): number {
  return selectSessionsAwaitingApproval(sessions).reduce(
    (total, s) => total + s.pendingCount,
    0,
  );
}
