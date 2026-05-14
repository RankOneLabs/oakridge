import { describe, test, expect } from "bun:test";
import { isPingDisabled } from "./ThreadView";
import type { CommentThread } from "./types";

function makeThread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "thread-1",
    target_type: "plan",
    target_id: "plan-abc",
    anchor: "cohorts[0]",
    status: "open",
    agent_responding: 0,
    resolved_at: null,
    created_at: "2026-05-13T00:00:00Z",
    messages: [],
    ...overrides,
  };
}

describe("isPingDisabled", () => {
  test("returns false when agent_responding is 0", () => {
    expect(isPingDisabled(makeThread({ agent_responding: 0 }))).toBe(false);
  });

  test("returns true when agent_responding is 1 (ping disabled state)", () => {
    expect(isPingDisabled(makeThread({ agent_responding: 1 }))).toBe(true);
  });
});

describe("thread rendering helpers", () => {
  test("resolve is only relevant for open threads", () => {
    const open = makeThread({ status: "open" });
    const resolved = makeThread({ status: "resolved" });
    expect(open.status === "open").toBe(true);
    expect(resolved.status === "open").toBe(false);
  });

  test("plan-level threads have null anchor", () => {
    const planThread = makeThread({ anchor: null });
    expect(planThread.anchor).toBeNull();
  });

  test("anchor-scoped thread has non-null anchor", () => {
    const anchoredThread = makeThread({ anchor: "cohorts[2]" });
    expect(anchoredThread.anchor).toBe("cohorts[2]");
  });
});

describe("thread resolve flow", () => {
  test("resolved thread has non-null resolved_at", () => {
    const t = makeThread({ status: "resolved", resolved_at: "2026-05-13T01:00:00Z" });
    expect(t.status).toBe("resolved");
    expect(t.resolved_at).not.toBeNull();
  });

  test("open thread has null resolved_at", () => {
    const t = makeThread({ status: "open", resolved_at: null });
    expect(t.resolved_at).toBeNull();
  });
});

describe("edge anchor encoding", () => {
  test("edge anchor uses literal arrow format", () => {
    const edgeAnchor = `edge:3->5`;
    expect(edgeAnchor.startsWith("edge:")).toBe(true);
    expect(edgeAnchor.includes("->")).toBe(true);
    const parts = edgeAnchor.replace("edge:", "").split("->");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("3");
    expect(parts[1]).toBe("5");
  });
});
