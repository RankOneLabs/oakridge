// Pure ordering/grouping over PwaSessionSnapshot (§14.1), shared by both
// the server (listPwaSessions — the source for GET /sessions and the
// /inbox SSE frames) and the PWA. One comparator, applied everywhere a
// session list is ordered, so a push frame never reshuffles what an
// operator is already looking at.

import type { PwaSessionSnapshot } from "./pwa-wire";

/** The unit id minted for a scalar stage. */
const SCALAR_STAGE_UNIT_ID = "0";
/** Must match the label boundary in `core/pwa/lib/time.ts`. */
export const JUST_NOW_WINDOW_MS = 5_000;

export type SessionActivityComparator = (
  left: PwaSessionSnapshot,
  right: PwaSessionSnapshot,
) => number;

export interface SessionCohortGroup {
  kind: "cohort";
  key: string;
  unitId: string;
  title: string | null;
  repositoryKey: string | null;
  sessions: PwaSessionSnapshot[];
}

export interface SessionStageGroup {
  kind: "stage";
  key: string;
  stageInstanceId: string;
  repositoryKey: string | null;
  sessions: PwaSessionSnapshot[];
}

export type SessionRunSubgroup = SessionCohortGroup | SessionStageGroup;

export interface SessionRunGroup {
  runId: string;
  groups: SessionRunSubgroup[];
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
 * Groups workflow-owned sessions by run, then by fan-out unit or scalar
 * stage. A cohort's build and assessment sessions share one run-scoped unit
 * group. Scalar stages use their stage-instance id because their minted unit
 * id is always "0" and carries no grouping identity of its own.
 */
export function groupSessionsByCohort(
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
    const runGroups = byRun.get(workflow.runId) ?? new Map<string, PwaSessionSnapshot[]>();
    byRun.set(workflow.runId, runGroups);
    const key = workflow.unitId === SCALAR_STAGE_UNIT_ID
      ? `stage:${workflow.stageInstanceId}`
      : `unit:${workflow.unitId}`;
    const existing = runGroups.get(key);
    if (existing === undefined) runGroups.set(key, [session]);
    else existing.push(session);
  }

  const runs: SessionRunGroup[] = [...byRun.entries()].map(([runId, runGroups]) => {
    const groups: SessionRunSubgroup[] = [...runGroups.entries()].map(([key, members]) => {
      const sorted = [...members].sort(compare_activity);
      // Every member here has a workflow identity and shares the key selected
      // above, so the first member carries the group's stable identifiers.
      const workflow = sorted[0].workflow as NonNullable<PwaSessionSnapshot["workflow"]>;
      const repositoryKey = firstNonNull(sorted, (session) => session.workflow?.repositoryKey ?? null);
      if (workflow.unitId === SCALAR_STAGE_UNIT_ID) {
        return {
          kind: "stage",
          key,
          stageInstanceId: workflow.stageInstanceId,
          repositoryKey,
          sessions: sorted,
        };
      }
      const title = firstNonNull(sorted, (session) => session.workflow?.cohortTitle ?? null)
        ?? workflow.unitId;
      return {
        kind: "cohort",
        key,
        unitId: workflow.unitId,
        title,
        repositoryKey,
        sessions: sorted,
      };
    });
    groups.sort((left, right) => compare_activity(left.sessions[0], right.sessions[0]));
    return { runId, groups };
  });

  runs.sort((left, right) => compare_activity(
    left.groups[0].sessions[0],
    right.groups[0].sessions[0],
  ));
  unattached.sort(compare_activity);

  return { runs, unattached };
}
