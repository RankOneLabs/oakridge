import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSnapshot } from "../types";
import { selectPendingPermissionToasts, useToastStore } from "./useToast";

const snapshot = (pendingPermissionCount: number): SessionSnapshot => ({
  sid: "sid-1",
  name: "Build session",
  agentProfile: "codex",
  status: "idle",
  source: "acp",
  lastActivityTs: "2026-09-27T10:00:00Z",
  createdAt: "2026-09-27T10:00:00Z",
  artifactId: null,
  projectWorkdir: "/repo",
  worktreePath: "/repo",
  worktreeBranch: null,
  worktreeBaseRef: null,
  requestedModel: null,
  requestedEffort: null,
  endReason: null,
  fencedBy: null,
  pendingPermissionCount,
  workflow: null,
});

describe("useToast store", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushToast appends a toast", () => {
    useToastStore.getState().pushToast({ kind: "success", message: "Merged." });
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("success");
    expect(toasts[0].message).toBe("Merged.");
  });

  it("dismissToast removes the toast by id", () => {
    useToastStore.getState().pushToast({ kind: "info", message: "Hello" });
    const { id } = useToastStore.getState().toasts[0];
    useToastStore.getState().dismissToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("toast auto-dismisses after ttlMs elapses", () => {
    useToastStore.getState().pushToast({ kind: "error", message: "Failed", ttlMs: 1000 });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("toast does not auto-dismiss before ttlMs elapses", () => {
    useToastStore.getState().pushToast({ kind: "error", message: "Failed", ttlMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it("creates a blocker toast only when the inbox permission count rises", () => {
    expect(selectPendingPermissionToasts([snapshot(1)], [snapshot(2)])).toEqual([{
      kind: "info",
      message: "2 approvals pending · Build session",
      href: "#sid=sid-1&focus=pending-permission",
    }]);
    expect(selectPendingPermissionToasts([snapshot(2)], [snapshot(2)])).toEqual([]);
    expect(selectPendingPermissionToasts([snapshot(2)], [snapshot(0)])).toEqual([]);
  });
});
