// Pure ordering/grouping over PwaSessionSnapshot (§14.1), shared by both
// the server (listPwaSessions — the source for GET /sessions and the
// /inbox SSE frames) and the PWA. One comparator, applied everywhere a
// session list is ordered, so a push frame never reshuffles what an
// operator is already looking at.

import type { PwaSessionSnapshot } from "./pwa-wire";

/** Must match the label boundary in `core/pwa/lib/time.ts`. */
export const JUST_NOW_WINDOW_MS = 5_000;

export type SessionActivityComparator = (
  left: PwaSessionSnapshot,
  right: PwaSessionSnapshot,
) => number;

/** The sessions one unit of a run started, newest activity first. */
export interface SessionUnitGroup {
  key: string;
  unitId: string;
  sessions: PwaSessionSnapshot[];
}

export interface SessionRunGroup {
  runId: string;
  units: SessionUnitGroup[];
}

export interface SessionRunGrouping {
  runs: SessionRunGroup[];
  unattached: PwaSessionSnapshot[];
}

/** Newest activity first; the one ordering every session list view uses. */
export function compareSessionsByActivity(
  left: PwaSessionSnapshot,
  right: PwaSessionSnapshot,
): number {
  if (left.lastActivityTs === right.lastActivityTs) return 0;
  return left.lastActivityTs < right.lastActivityTs ? 1 : -1;
}

const isJustNow = (session: PwaSessionSnapshot, now_ms: number): boolean => {
  const activity_ms = Date.parse(session.lastActivityTs);
  return Number.isFinite(activity_ms)
    && Math.max(0, now_ms - activity_ms) < JUST_NOW_WINDOW_MS;
};

/**
 * The inbox order operators see. Two rows carrying the same "just now"
 * label compare equal, so stable sort preserves their established position
 * instead of making them jump whenever one receives another event.
 */
export const compareSessionsByDisplayedActivity = (
  now_ms: number,
): SessionActivityComparator => (left, right) =>
  isJustNow(left, now_ms) && isJustNow(right, now_ms)
    ? 0
    : compareSessionsByActivity(left, right);

/** Milliseconds until the next session leaves the displayed just-now bucket. */
export function selectNextJustNowExpiryDelay(
  sessions: readonly PwaSessionSnapshot[],
  now_ms: number,
): number | null {
  let nextDelay: number | null = null;
  for (const session of sessions) {
    const activity_ms = Date.parse(session.lastActivityTs);
    if (!Number.isFinite(activity_ms)) continue;
    const delay = activity_ms + JUST_NOW_WINDOW_MS - now_ms;
    if (delay <= 0) continue;
    nextDelay = nextDelay === null ? delay : Math.min(nextDelay, delay);
  }
  return nextDelay;
}

/** Groups workflow-owned sessions by run, then by the unit whose attempts started them. */
export function groupSessionsByRun(
  sessions: readonly PwaSessionSnapshot[],
  compare_activity: SessionActivityComparator = compareSessionsByActivity,
): SessionRunGrouping {
  const byRun = new Map<string, Map<string, PwaSessionSnapshot[]>>();
  const unattached: PwaSessionSnapshot[] = [];

  for (const session of sessions) {
    const workflow = session.workflow;
    if (workflow === null) {
      unattached.push(session);
      continue;
    }
    const runUnits = byRun.get(workflow.runId) ?? new Map<string, PwaSessionSnapshot[]>();
    byRun.set(workflow.runId, runUnits);
    const existing = runUnits.get(workflow.unitId);
    if (existing === undefined) runUnits.set(workflow.unitId, [session]);
    else existing.push(session);
  }

  const runs: SessionRunGroup[] = [...byRun.entries()].map(([runId, runUnits]) => {
    const units = [...runUnits.entries()].map(([unitId, members]): SessionUnitGroup =>
      ({ key: `unit:${unitId}`, unitId, sessions: [...members].sort(compare_activity) }));
    units.sort((left, right) => compare_activity(left.sessions[0], right.sessions[0]));
    return { runId, units };
  });

  runs.sort((left, right) => compare_activity(left.units[0].sessions[0], right.units[0].sessions[0]));
  unattached.sort(compare_activity);

  return { runs, unattached };
}
