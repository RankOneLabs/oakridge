import { describe, expect, it } from "vitest";

import type { Sid } from "./ids";
import type { SessionSnapshot } from "../types";
import {
  selectPendingApprovalCount,
  selectSessionView,
  selectSessionsAwaitingApproval,
  selectSidebarSessions,
  selectSortedSessions,
} from "./selectors";

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001",
    name: "test-session",
    agentProfile: "claude-code",
    status: "idle",
    source: "acp",
    lastActivityTs: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    artifactId: null,
    projectWorkdir: "/repo",
    worktreePath: "/tmp/worktrees/x",
    worktreeBranch: "kbbl/abc123",
    worktreeBaseRef: null,
    requestedModel: null,
    requestedEffort: null,
    endReason: null,
    fencedBy: null,
    pendingPermissionCount: 0,
    ...overrides,
  };
}

describe("selectSortedSessions", () => {
  it("orders newest activity first", () => {
    const older = makeSnapshot({
      sid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001",
      lastActivityTs: "2026-01-01T00:00:00.000Z",
    });
    const newer = makeSnapshot({
      sid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000002",
      lastActivityTs: "2026-01-02T00:00:00.000Z",
    });
    const sorted = selectSortedSessions(
      new Map([
        [older.sid as Sid, older],
        [newer.sid as Sid, newer],
      ]),
    );
    expect(sorted.map((s) => s.sid)).toEqual([newer.sid, older.sid]);
  });
});

describe("selectSidebarSessions", () => {
  it("projects the sidebar subset with the project workdir", () => {
    const snapshot = makeSnapshot();
    expect(selectSidebarSessions([snapshot])).toEqual([
      {
        sid: snapshot.sid,
        name: "test-session",
        workdir: "/repo",
        status: "idle",
      },
    ]);
  });
});

describe("selectSessionView", () => {
  it("returns the snapshot and inbox status for a known sid", () => {
    const snapshot = makeSnapshot();
    const bundle = selectSessionView(
      {
        sessions: new Map([[snapshot.sid as Sid, snapshot]]),
        inboxStatus: "connected",
      },
      snapshot.sid as Sid,
    );
    expect(bundle.snapshot).toBe(snapshot);
    expect(bundle.inboxStatus).toBe("connected");
  });

  it("returns a null snapshot for an unknown sid", () => {
    const bundle = selectSessionView(
      { sessions: new Map(), inboxStatus: "connecting" },
      "aaaaaaaa-bbbb-4ccc-8ddd-00000000ffff" as Sid,
    );
    expect(bundle.snapshot).toBeNull();
  });
});

describe("approval selectors", () => {
  it("lists only open sessions with pending permissions, newest first", () => {
    const waiting = makeSnapshot({
      sid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001",
      pendingPermissionCount: 2,
      lastActivityTs: "2026-01-01T00:00:00.000Z",
    });
    const waitingNewer = makeSnapshot({
      sid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000002",
      pendingPermissionCount: 1,
      lastActivityTs: "2026-01-02T00:00:00.000Z",
    });
    const quiet = makeSnapshot({
      sid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000003",
    });
    const closed = makeSnapshot({
      sid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000004",
      status: "fenced",
      pendingPermissionCount: 3,
    });
    const waiters = selectSessionsAwaitingApproval([
      waiting,
      waitingNewer,
      quiet,
      closed,
    ]);
    expect(waiters.map((w) => w.sid)).toEqual([waitingNewer.sid, waiting.sid]);
    expect(selectPendingApprovalCount([waiting, waitingNewer, quiet, closed])).toBe(3);
  });
});
