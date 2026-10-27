import { beforeEach, expect, test } from "vitest";

import type { Sid } from "../lib/ids";
import type { SessionSnapshot } from "../types";
import { useStore } from "./store";

function makeSnapshot(sid: string, status: SessionSnapshot["status"]): SessionSnapshot {
  return {
    sid,
    name: sid,
    agentProfile: "claude-code",
    status,
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
    archivedAt: null,
    pendingPermissionCount: 0,
    workflow: null,
  };
}

beforeEach(() => useStore.setState({ sessions: new Map() }));

test("single close archives a live session as ended while retaining its sid", () => {
  const sid = "live" as Sid;
  useStore.setState({ sessions: new Map([[sid, makeSnapshot(sid, "idle")]]) });

  useStore.getState().archiveSession({ kind: "end_and_archive", sid });

  expect(useStore.getState().sessions.get(sid)).toMatchObject({
    sid,
    status: "ended",
    archivedAt: expect.any(String),
  });
});

test("single close preserves an already-terminal status", () => {
  const sid = "failed" as Sid;
  useStore.setState({ sessions: new Map([[sid, makeSnapshot(sid, "failed")]]) });

  useStore.getState().archiveSession({ kind: "end_and_archive", sid });

  expect(useStore.getState().sessions.get(sid)).toMatchObject({
    status: "failed",
    archivedAt: expect.any(String),
  });
});

test("bulk hide preserves a terminal status", () => {
  const sid = "fenced" as Sid;
  useStore.setState({ sessions: new Map([[sid, makeSnapshot(sid, "fenced")]]) });

  useStore.getState().archiveSession({ kind: "archive", sid });

  expect(useStore.getState().sessions.get(sid)).toMatchObject({
    status: "fenced",
    archivedAt: expect.any(String),
  });
});
