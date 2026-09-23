import { expect, test } from "bun:test";

import {
  compareSessionsByActivity,
  compareSessionsByDisplayedActivity,
  groupSessionsByCohort,
  selectNextJustNowExpiryDelay,
} from "./pwa-session-order";
import type { PwaSessionSnapshot, PwaSessionWorkflowIdentity } from "./pwa-wire";

function workflow(overrides: Partial<PwaSessionWorkflowIdentity> = {}): PwaSessionWorkflowIdentity {
  return {
    runId: "run-1",
    stageInstanceId: "stage-build",
    unitId: "cohort-a",
    operatorRole: "build",
    cohortTitle: null,
    repositoryKey: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<PwaSessionSnapshot> = {}): PwaSessionSnapshot {
  return {
    sid: "sid-1",
    name: "build-stage-1-cohort-a",
    agentProfile: "claude-code",
    status: "idle",
    source: "acp",
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

test("a build session and an assessor session sharing a run and unit land in one group", () => {
  const build = makeSnapshot({ sid: "build-1", workflow: workflow({ operatorRole: "build" }) });
  const assess = makeSnapshot({
    sid: "assess-1",
    workflow: workflow({ operatorRole: "assessment", stageInstanceId: "stage-assess" }),
  });
  const grouping = groupSessionsByCohort([build, assess]);
  expect(grouping.groups).toHaveLength(1);
  expect(grouping.groups[0]?.sessions.map((s) => s.sid).sort()).toEqual(["assess-1", "build-1"]);
  expect(grouping.ungrouped).toEqual([]);
});

test("the build member's cohort title wins when the assessor member carries none", () => {
  const build = makeSnapshot({
    sid: "build-1",
    lastActivityTs: "2026-01-01T00:00:00.000Z",
    workflow: workflow({ cohortTitle: "Targets spec contract" }),
  });
  const assess = makeSnapshot({
    sid: "assess-1",
    lastActivityTs: "2026-01-02T00:00:00.000Z",
    workflow: workflow({ operatorRole: "assessment", cohortTitle: null }),
  });
  const grouping = groupSessionsByCohort([build, assess]);
  expect(grouping.groups[0]?.title).toBe("Targets spec contract");
});

test("a group with no titled member falls back to the unit id", () => {
  const build = makeSnapshot({ sid: "build-1", workflow: workflow({ cohortTitle: null }) });
  const grouping = groupSessionsByCohort([build]);
  expect(grouping.groups[0]?.title).toBe("cohort-a");
});

test("the group's repositoryKey is the first non-null one among its members", () => {
  const build = makeSnapshot({ sid: "build-1", workflow: workflow({ repositoryKey: null }) });
  const assess = makeSnapshot({
    sid: "assess-1",
    workflow: workflow({ operatorRole: "assessment", repositoryKey: "pipefitter" }),
  });
  const grouping = groupSessionsByCohort([build, assess]);
  expect(grouping.groups[0]?.repositoryKey).toBe("pipefitter");
});

test("a null workflow lands in ungrouped and never creates a group", () => {
  const handStarted = makeSnapshot({ sid: "hand-1", workflow: null });
  const grouping = groupSessionsByCohort([handStarted]);
  expect(grouping.groups).toEqual([]);
  expect(grouping.ungrouped.map((s) => s.sid)).toEqual(["hand-1"]);
});

test("unitId '0' lands in ungrouped and never creates a group", () => {
  const scalar = makeSnapshot({ sid: "scalar-1", workflow: workflow({ unitId: "0" }) });
  const grouping = groupSessionsByCohort([scalar]);
  expect(grouping.groups).toEqual([]);
  expect(grouping.ungrouped.map((s) => s.sid)).toEqual(["scalar-1"]);
});

test("groups order by their most recent member's activity, descending; members order the same way within a group", () => {
  const olderGroupOld = makeSnapshot({
    sid: "older-old", lastActivityTs: "2026-01-01T00:00:00.000Z",
    workflow: workflow({ unitId: "cohort-old" }),
  });
  const olderGroupNew = makeSnapshot({
    sid: "older-new", lastActivityTs: "2026-01-03T00:00:00.000Z",
    workflow: workflow({ unitId: "cohort-old", operatorRole: "assessment" }),
  });
  const newerGroup = makeSnapshot({
    sid: "newer-only", lastActivityTs: "2026-01-05T00:00:00.000Z",
    workflow: workflow({ unitId: "cohort-new" }),
  });
  const grouping = groupSessionsByCohort([olderGroupOld, olderGroupNew, newerGroup]);
  expect(grouping.groups.map((g) => g.unitId)).toEqual(["cohort-new", "cohort-old"]);
  expect(grouping.groups[1]?.sessions.map((s) => s.sid)).toEqual(["older-new", "older-old"]);
});

test("the ungrouped section is sorted by activity, newest first", () => {
  const older = makeSnapshot({ sid: "a", lastActivityTs: "2026-01-01T00:00:00.000Z", workflow: null });
  const newer = makeSnapshot({ sid: "b", lastActivityTs: "2026-01-02T00:00:00.000Z", workflow: null });
  const grouping = groupSessionsByCohort([older, newer]);
  expect(grouping.ungrouped.map((s) => s.sid)).toEqual(["b", "a"]);
});
