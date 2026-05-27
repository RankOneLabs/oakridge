import { describe, expect, it } from "vitest";

import type { Sid } from "./ids";
import {
  selectPendingReviewsCount,
  selectSessionView,
  selectSidebarSessions,
  selectSortedSessions,
} from "./selectors";
import type {
  CompactSuggestion,
  PendingBriefCard,
  PendingPlanCard,
  SessionSnapshot,
  Status,
} from "../types";

function snap(over: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    sid: over.sid ?? "sid-default",
    name: over.name ?? "name",
    workdir: over.workdir ?? "/tmp/wd",
    status: over.status ?? "live",
    createdAt: over.createdAt ?? "2026-05-22T00:00:00Z",
    lastActivityTs: over.lastActivityTs ?? "2026-05-22T00:00:00Z",
    runtimeId: over.runtimeId ?? "claude-code",
    runtimeSid: over.runtimeSid ?? null,
    ccSid: over.ccSid ?? null,
    parentCcSid: over.parentCcSid ?? null,
    parentOakridgeSid: over.parentOakridgeSid ?? null,
    artifactId: over.artifactId ?? null,
    pendingCount: over.pendingCount ?? 0,
    yoloMode: over.yoloMode ?? false,
    allowedTools: over.allowedTools ?? [],
    lastResultUsage: over.lastResultUsage ?? null,
    worktreePath: over.worktreePath ?? null,
    worktreeBranch: over.worktreeBranch ?? null,
    worktreeBaseRef: over.worktreeBaseRef ?? null,
    projectWorkdir: over.projectWorkdir ?? null,
    model: over.model ?? null,
    initialObservedModel: over.initialObservedModel ?? null,
    observedModel: over.observedModel ?? null,
    endReason: over.endReason ?? null,
    successorSid: over.successorSid ?? null,
  };
}

describe("selectSortedSessions", () => {
  it("returns newest activity first", () => {
    const a = snap({ sid: "a", lastActivityTs: "2026-05-22T00:00:01Z" });
    const b = snap({ sid: "b", lastActivityTs: "2026-05-22T00:00:03Z" });
    const c = snap({ sid: "c", lastActivityTs: "2026-05-22T00:00:02Z" });
    const m = new Map<Sid, SessionSnapshot>([
      ["a" as Sid, a],
      ["b" as Sid, b],
      ["c" as Sid, c],
    ]);
    expect(selectSortedSessions(m).map((s) => s.sid)).toEqual(["b", "c", "a"]);
  });

  it("returns an empty list when the map is empty", () => {
    expect(selectSortedSessions(new Map())).toEqual([]);
  });
});

describe("selectSidebarSessions", () => {
  it("projects to {sid, name, workdir, status}", () => {
    const sorted = [
      snap({ sid: "a", name: "alpha", workdir: "/tmp/a", status: "live" }),
    ];
    expect(selectSidebarSessions(sorted)).toEqual([
      { sid: "a", name: "alpha", workdir: "/tmp/a", status: "live" },
    ]);
  });

  it("prefers projectWorkdir over workdir when both are present", () => {
    const sorted = [
      snap({
        sid: "a",
        name: "alpha",
        workdir: "/tmp/.../worktrees/abc",
        projectWorkdir: "/home/me/repo",
        status: "live",
      }),
    ];
    expect(selectSidebarSessions(sorted)[0].workdir).toBe("/home/me/repo");
  });

  it("falls back to workdir when projectWorkdir is null", () => {
    const sorted = [
      snap({ sid: "a", name: "alpha", workdir: "/legacy/path", projectWorkdir: null }),
    ];
    expect(selectSidebarSessions(sorted)[0].workdir).toBe("/legacy/path");
  });
});

describe("selectSessionView", () => {
  function state(over?: {
    sessions?: Map<Sid, SessionSnapshot>;
    inMemorySids?: Set<Sid>;
    inboxStatus?: Status;
    compactSuggestions?: Map<Sid, CompactSuggestion>;
  }) {
    return {
      sessions: over?.sessions ?? new Map<Sid, SessionSnapshot>(),
      inMemorySids: over?.inMemorySids ?? new Set<Sid>(),
      inboxStatus: over?.inboxStatus ?? ("connected" as Status),
      compactSuggestions:
        over?.compactSuggestions ?? new Map<Sid, CompactSuggestion>(),
    };
  }

  it("returns snapshot/inMemory/compactSuggestion when present", () => {
    const s = snap({ sid: "a" });
    const bundle = selectSessionView(
      state({
        sessions: new Map<Sid, SessionSnapshot>([["a" as Sid, s]]),
        inMemorySids: new Set<Sid>(["a" as Sid]),
        inboxStatus: "connected",
        compactSuggestions: new Map([["a" as Sid, { sid: "a", tokens: 42_000 }]]),
      }),
      "a" as Sid,
    );
    expect(bundle.snapshot).toBe(s);
    expect(bundle.inMemory).toBe(true);
    expect(bundle.inboxStatus).toBe("connected");
    expect(bundle.compactSuggestion).toEqual({ sid: "a", tokens: 42_000 });
  });

  it("returns nulls when the sid is unknown to the store", () => {
    const bundle = selectSessionView(state(), "missing" as Sid);
    expect(bundle.snapshot).toBeNull();
    expect(bundle.inMemory).toBe(false);
    expect(bundle.compactSuggestion).toBeNull();
  });
});

describe("selectPendingReviewsCount", () => {
  it("sums the lengths of both lists", () => {
    const plans: PendingPlanCard[] = [
      { id: "p1", spec_id: "s1", status: "pending_approval", created_at: "" },
      { id: "p2", spec_id: "s2", status: "pending_approval", created_at: "" },
    ];
    const briefs: PendingBriefCard[] = [
      { id: "b1", cohort_id: "c1", goal: "g", status: "pending_approval", created_at: "" },
    ];
    expect(selectPendingReviewsCount(plans, briefs)).toBe(3);
  });

  it("returns 0 when both lists are empty", () => {
    expect(selectPendingReviewsCount([], [])).toBe(0);
  });
});
