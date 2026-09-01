import type { Sid } from "./ids";
import { sortSessions } from "./session";
import type { AppState } from "../state/store";
import type {
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
 * needs. projectWorkdir (the canonical repo path) is what the sidebar
 * groups by — worktree-backed sessions live under
 * /tmp/.../worktrees/<branch>.
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
    workdir: s.projectWorkdir,
    status: s.status,
  }));
}

/**
 * Composite SessionView needs for a single sid: snapshot (or null if not
 * loaded) and the current inbox status.
 */
export interface SessionViewBundle {
  snapshot: SessionSnapshot | null;
  inboxStatus: Status;
}

export function selectSessionView(
  state: Pick<AppState, "sessions" | "inboxStatus">,
  sid: Sid,
): SessionViewBundle {
  return {
    snapshot: state.sessions.get(sid) ?? null,
    inboxStatus: state.inboxStatus,
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

/** One session with at least one permission request awaiting an answer. */
export interface ApprovalWaiter {
  sid: string;
  name: string;
  pendingCount: number;
}

/**
 * Sessions with at least one pending permission request, newest-activity
 * first. Powers the global approval badge so a parked permission is
 * visible from any view — not only inside that session's own
 * conversation, where it would otherwise sit unseen. A closed session's
 * pending count is already 0 (pending permissions do not survive the
 * child); the status filter is defensive.
 */
export function selectSessionsAwaitingApproval(
  sessions: SessionSnapshot[],
): ApprovalWaiter[] {
  return sessions
    .filter(
      (s) =>
        s.pendingPermissionCount > 0 &&
        s.status !== "ended" &&
        s.status !== "fenced" &&
        s.status !== "failed",
    )
    .sort((a, b) => Date.parse(b.lastActivityTs) - Date.parse(a.lastActivityTs))
    .map((s) => ({
      sid: s.sid,
      name: s.name,
      pendingCount: s.pendingPermissionCount,
    }));
}

/** Total parked permission requests across open sessions (badge count). */
export function selectPendingApprovalCount(sessions: SessionSnapshot[]): number {
  return selectSessionsAwaitingApproval(sessions).reduce(
    (total, s) => total + s.pendingCount,
    0,
  );
}
