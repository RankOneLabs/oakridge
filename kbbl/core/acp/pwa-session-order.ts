// Pure ordering/grouping over PwaSessionSnapshot (§14.1), shared by both
// the server (listPwaSessions — the source for GET /sessions and the
// /inbox SSE frames) and the PWA. One comparator, applied everywhere a
// session list is ordered, so a push frame never reshuffles what an
// operator is already looking at.

import type { PwaSessionSnapshot } from "./pwa-wire";

/** A session with no workflow identity, or a scalar stage's unit "0". */
const UNGROUPED_UNIT_ID = "0";
/** Must match the label boundary in `core/pwa/lib/time.ts`. */
export const JUST_NOW_WINDOW_MS = 5_000;

export type SessionActivityComparator = (
  left: PwaSessionSnapshot,
  right: PwaSessionSnapshot,
) => number;

export interface SessionCohortGroup {
  key: string;
  runId: string;
  unitId: string;
  title: string | null;
  repositoryKey: string | null;
  sessions: PwaSessionSnapshot[];
}

export interface SessionCohortGrouping {
  groups: SessionCohortGroup[];
  ungrouped: PwaSessionSnapshot[];
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

function firstNonNull(
  sessions: readonly PwaSessionSnapshot[],
  select: (session: PwaSessionSnapshot) => string | null,
): string | null {
  for (const session of sessions) {
    const value = select(session);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Groups sessions sharing a run and fan-out unit — a cohort's build and
 * assessment sessions — under one heading. The group key is
 * `${runId}:${unitId}`, deliberately run-scoped rather than the server's
 * per-stage `${stageInstanceId}:${unitId}`: the per-stage key would keep
 * build and assessment in separate groups, exactly the split this exists
 * to remove. Safe because duplicate unit_ids within one stage instance are
 * already rejected at mint time.
 */
export function groupSessionsByCohort(
  sessions: readonly PwaSessionSnapshot[],
  compare_activity: SessionActivityComparator = compareSessionsByActivity,
): SessionCohortGrouping {
  const byKey = new Map<string, PwaSessionSnapshot[]>();
  const ungrouped: PwaSessionSnapshot[] = [];

  for (const session of sessions) {
    const workflow = session.workflow;
    if (workflow === null || workflow.unitId === UNGROUPED_UNIT_ID) {
      ungrouped.push(session);
      continue;
    }
    const key = `${workflow.runId}:${workflow.unitId}`;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, [session]);
    else existing.push(session);
  }

  const groups: SessionCohortGroup[] = [...byKey.entries()].map(([key, members]) => {
    const sorted = [...members].sort(compare_activity);
    // Every member of this group has a non-null workflow with this unitId,
    // by construction of the loop above.
    const workflow = sorted[0].workflow as NonNullable<PwaSessionSnapshot["workflow"]>;
    const title = firstNonNull(sorted, (session) => session.workflow?.cohortTitle ?? null) ?? workflow.unitId;
    const repositoryKey = firstNonNull(sorted, (session) => session.workflow?.repositoryKey ?? null);
    return { key, runId: workflow.runId, unitId: workflow.unitId, title, repositoryKey, sessions: sorted };
  });

  groups.sort((left, right) => compare_activity(left.sessions[0], right.sessions[0]));
  ungrouped.sort(compare_activity);

  return { groups, ungrouped };
}
