import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useSessionStream } from "./useSessionStream";
import type { EnvelopeEvent } from "../types";

// jsdom has no EventSource; capture the instance the hook opens so tests can
// push frames at it directly.
class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: MockEventSource | null = null;
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  // Real EventSource opens asynchronously; start OPEN so the revive check
  // treats a live instance as healthy unless a test forces it CLOSED.
  readyState = MockEventSource.OPEN;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.last = this;
    MockEventSource.instances.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }
}

function emit(evt: EnvelopeEvent) {
  act(() => {
    MockEventSource.last?.onmessage?.({ data: JSON.stringify(evt) });
  });
}

describe("useSessionStream pty_output routing", () => {
  beforeEach(() => {
    MockEventSource.last = null;
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes pty_output to the sink and keeps it out of the events array", () => {
    const sink = vi.fn();
    const { result } = renderHook(() => useSessionStream("sid-1", true, sink));

    emit({ id: 1, type: "pty_output", ts: "t", payload: { content: "hello " } });
    emit({ id: 2, type: "pty_output", ts: "t", payload: { content: "world" } });

    expect(sink.mock.calls).toEqual([["hello "], ["world"]]);
    // High-volume bytes must never enter React state.
    expect(result.current.events).toHaveLength(0);
  });

  it("ignores a pty_output whose content is not a string", () => {
    const sink = vi.fn();
    const { result } = renderHook(() => useSessionStream("sid-1", true, sink));

    emit({ id: 1, type: "pty_output", ts: "t", payload: { content: 42 } });

    expect(sink).not.toHaveBeenCalled();
    expect(result.current.events).toHaveLength(0);
  });

  it("still appends non-pty_output events to the events array", () => {
    const sink = vi.fn();
    const { result } = renderHook(() => useSessionStream("sid-1", true, sink));

    emit({ id: 1, type: "user", ts: "t", payload: { message: { content: "hi" } } });

    expect(sink).not.toHaveBeenCalled();
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].type).toBe("user");
  });

  it("rebuilds a dead stream when the page returns to the foreground", () => {
    renderHook(() => useSessionStream("sid-1", true));
    expect(MockEventSource.instances).toHaveLength(1);

    // Simulate the tablet-background case: the socket is killed and the browser
    // does not auto-resume it.
    act(() => {
      MockEventSource.last!.readyState = MockEventSource.CLOSED;
      MockEventSource.last!.onerror?.({});
    });

    // Operator wakes the tablet / refocuses the tab.
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  it("does not rebuild a healthy (OPEN) stream on refocus", () => {
    renderHook(() => useSessionStream("sid-1", true));
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(MockEventSource.instances).toHaveLength(1);
  });
});
