import { expect, test } from "bun:test";

import {
  compareSessionsByActivity,
  compareSessionsByDisplayedActivity,
  groupSessionsByRun,
  selectNextJustNowExpiryDelay,
} from "./pwa-session-order";
import type { PwaSessionSnapshot, PwaSessionWorkflowIdentity } from "./pwa-wire";

function workflow(overrides: Partial<PwaSessionWorkflowIdentity> = {}): PwaSessionWorkflowIdentity {
  return { runId: "run-1", unitId: "unit-a", worker: "builder", ...overrides };
}

function makeSnapshot(overrides: Partial<PwaSessionSnapshot> = {}): PwaSessionSnapshot {
  return {
    sid: "sid-1",
    name: "build-stage-1-cohort-a",
    agentProfile: "claude-code",
    status: "idle",
    lastActivityTs: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    artifactId: null,
    projectWorkdir: "/repo",
    worktreePath: "/repo/worktree",
    worktreeBranch: null,
    worktreeBaseRef: null,
    requestedModel: null,
    requestedEffort: null,
    endReason: null,
    fencedBy: null,
    pendingPermissionCount: 0,
    workflow: null,
    ...overrides,
  };
}

test("compareSessionsByActivity orders newest first", () => {
  const older = makeSnapshot({ sid: "a", lastActivityTs: "2026-01-01T00:00:00.000Z" });
  const newer = makeSnapshot({ sid: "b", lastActivityTs: "2026-01-02T00:00:00.000Z" });
  expect([older, newer].sort(compareSessionsByActivity).map((s) => s.sid)).toEqual(["b", "a"]);
});

test("display ordering preserves input order while both sessions read just now", () => {
  const now = Date.parse("2026-01-01T00:00:05.000Z");
  const establishedFirst = makeSnapshot({ sid: "first", lastActivityTs: "2026-01-01T00:00:03.000Z" });
  const newlyActive = makeSnapshot({ sid: "second", lastActivityTs: "2026-01-01T00:00:04.900Z" });

  expect(
    [establishedFirst, newlyActive]
      .sort(compareSessionsByDisplayedActivity(now))
      .map((session) => session.sid),
  ).toEqual(["first", "second"]);
});

test("display ordering returns to newest-first outside the shared just-now bucket", () => {
  const now = Date.parse("2026-01-01T00:01:00.000Z");
  const older = makeSnapshot({ sid: "older", lastActivityTs: "2026-01-01T00:00:03.000Z" });
  const newer = makeSnapshot({ sid: "newer", lastActivityTs: "2026-01-01T00:00:04.900Z" });

  expect(
    [older, newer]
      .sort(compareSessionsByDisplayedActivity(now))
      .map((session) => session.sid),
  ).toEqual(["newer", "older"]);
});

test("selectNextJustNowExpiryDelay returns the earliest displayed bucket boundary", () => {
  const now = Date.parse("2026-01-01T00:00:05.000Z");
  const expiresFirst = makeSnapshot({ lastActivityTs: "2026-01-01T00:00:03.000Z" });
  const expiresLater = makeSnapshot({ lastActivityTs: "2026-01-01T00:00:04.000Z" });

  expect(selectNextJustNowExpiryDelay([expiresLater, expiresFirst], now)).toBe(3_000);
});

test("selectNextJustNowExpiryDelay ignores sessions outside the bucket", () => {
  const now = Date.parse("2026-01-01T00:01:00.000Z");
  const expired = makeSnapshot({ lastActivityTs: "2026-01-01T00:00:03.000Z" });

  expect(selectNextJustNowExpiryDelay([expired], now)).toBeNull();
});

test("a builder session and an assessor session on one unit land in one group", () => {
  const build = makeSnapshot({ sid: "build-1", workflow: workflow({ worker: "builder" }) });
  const assess = makeSnapshot({ sid: "assess-1", workflow: workflow({ worker: "assessor" }) });
  const grouping = groupSessionsByRun([build, assess]);
  expect(grouping.runs).toHaveLength(1);
  expect(grouping.runs[0]?.units[0]).toMatchObject({ unitId: "unit-a" });
  expect(grouping.runs[0]?.units[0]?.sessions.map((s) => s.sid).sort()).toEqual(["assess-1", "build-1"]);
  expect(grouping.unattached).toEqual([]);
});

test("a null workflow is unattached and never creates a run", () => {
  const handStarted = makeSnapshot({ sid: "hand-1", workflow: null });
  const grouping = groupSessionsByRun([handStarted]);
  expect(grouping.runs).toEqual([]);
  expect(grouping.unattached.map((s) => s.sid)).toEqual(["hand-1"]);
});

test("runs and units order by their most recent session; sessions use the same ordering", () => {
  const olderUnitOld = makeSnapshot({ sid: "older-old", lastActivityTs: "2026-01-01T00:00:00.000Z", workflow: workflow({ unitId: "unit-old" }) });
  const olderUnitNew = makeSnapshot({ sid: "older-new", lastActivityTs: "2026-01-03T00:00:00.000Z",
    workflow: workflow({ unitId: "unit-old", worker: "assessor" }) });
  const middleUnit = makeSnapshot({ sid: "middle-only", lastActivityTs: "2026-01-04T00:00:00.000Z", workflow: workflow({ unitId: "unit-middle" }) });
  const newerUnit = makeSnapshot({ sid: "newer-only", lastActivityTs: "2026-01-05T00:00:00.000Z",
    workflow: workflow({ runId: "run-2", unitId: "unit-new" }) });
  const grouping = groupSessionsByRun([olderUnitOld, olderUnitNew, middleUnit, newerUnit]);
  expect(grouping.runs.map((run) => run.runId)).toEqual(["run-2", "run-1"]);
  expect(grouping.runs[1]?.units.map((unit) => unit.sessions[0]?.sid)).toEqual(["middle-only", "older-new"]);
  expect(grouping.runs[1]?.units[1]?.sessions.map((s) => s.sid)).toEqual(["older-new", "older-old"]);
});

test("the unattached section is sorted by activity, newest first", () => {
  const older = makeSnapshot({ sid: "a", lastActivityTs: "2026-01-01T00:00:00.000Z", workflow: null });
  const newer = makeSnapshot({ sid: "b", lastActivityTs: "2026-01-02T00:00:00.000Z", workflow: null });
  const grouping = groupSessionsByRun([older, newer]);
  expect(grouping.unattached.map((s) => s.sid)).toEqual(["b", "a"]);
});
