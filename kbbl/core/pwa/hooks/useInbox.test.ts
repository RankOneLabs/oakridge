import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import { useInbox } from "./useInbox";
import { useStore } from "../state/store";

// jsdom has no EventSource; capture instances so tests can push frames.
class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: MockEventSource | null = null;
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readyState = MockEventSource.OPEN;
  closed = false;
  private listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    MockEventSource.last = this;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: { data: string }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener() {}
  dispatch(type: string, data: string) {
    for (const cb of this.listeners[type] ?? []) cb({ data });
  }
  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  return Wrapper;
}

describe("useInbox EventSource revival and parse guards", () => {
  beforeEach(() => {
    MockEventSource.last = null;
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sessions: [] }),
      }),
    );
    useStore.setState({ inboxStatus: "connecting", sessions: new Map(), removedSids: new Set() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconnects a CLOSED /inbox EventSource when the page returns to the foreground", () => {
    renderHook(() => useInbox(), { wrapper: makeWrapper() });
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => {
      MockEventSource.last!.readyState = MockEventSource.CLOSED;
      MockEventSource.last!.onerror?.({});
    });

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  it("does not rebuild a healthy (OPEN) /inbox stream on refocus", () => {
    renderHook(() => useInbox(), { wrapper: makeWrapper() });
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("sets inboxStatus=stale and does not throw on a malformed snapshot frame", () => {
    vi.useFakeTimers();
    renderHook(() => useInbox(), { wrapper: makeWrapper() });

    act(() => {
      MockEventSource.last!.onopen?.({});
    });
    expect(useStore.getState().inboxStatus).toBe("connected");

    act(() => {
      MockEventSource.last!.dispatch("snapshot", "not json {{{");
    });

    expect(useStore.getState().inboxStatus).toBe("stale");
    expect(MockEventSource.instances[0]!.closed).toBe(true);

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("folds snapshot frames into the store and reports removed sids", () => {
    const removed: string[] = [];
    renderHook(() => useInbox({ onSessionRemoved: (sid) => removed.push(sid) }), {
      wrapper: makeWrapper(),
    });

    const snapshot = {
      sid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001",
      name: "one",
      agentProfile: "claude-code",
      status: "idle",
      source: "acp",
      lastActivityTs: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      artifactId: null,
      projectWorkdir: "/repo",
      worktreePath: "/repo",
      worktreeBranch: null,
      worktreeBaseRef: null,
      requestedModel: null,
      requestedEffort: null,
      endReason: null,
      fencedBy: null,
      pendingPermissionCount: 0,
    };

    act(() => {
      MockEventSource.last!.dispatch(
        "snapshot",
        JSON.stringify({ sessions: [snapshot] }),
      );
    });
    expect(useStore.getState().sessions.get(snapshot.sid as never)?.name).toBe("one");

    act(() => {
      MockEventSource.last!.dispatch("snapshot", JSON.stringify({ sessions: [] }));
    });
    expect(useStore.getState().sessions.has(snapshot.sid as never)).toBe(false);
    expect(removed).toEqual([snapshot.sid]);
  });
});
