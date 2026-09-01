import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useAcpSession } from "./useAcpSession";

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

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";

function agentFrame(text: string): string {
  return JSON.stringify({
    kind: "agent_message",
    id: "m1",
    content: [{ type: "text", text }],
    streaming: true,
    replayed: false,
  });
}

describe("useAcpSession", () => {
  beforeEach(() => {
    MockEventSource.last = null;
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    // Async like the real thing: a synchronous stub would run the flush
    // before the hook stores the frame handle.
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback): number =>
        setTimeout(() => cb(0), 0) as unknown as number,
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends acp frames after the epoch frame", async () => {
    const { result } = renderHook(() => useAcpSession(SID));
    act(() => {
      MockEventSource.last!.dispatch(
        "epoch",
        JSON.stringify({ stream_epoch: "e1", expired: false }),
      );
      MockEventSource.last!.dispatch("acp", agentFrame("hello"));
    });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.expired).toBe(false);
  });

  it("a fresh epoch frame resets the accumulated timeline (reconnect replay)", async () => {
    const { result } = renderHook(() => useAcpSession(SID));
    act(() => {
      MockEventSource.last!.dispatch(
        "epoch",
        JSON.stringify({ stream_epoch: "e1", expired: false }),
      );
      MockEventSource.last!.dispatch("acp", agentFrame("one"));
      MockEventSource.last!.dispatch("acp", agentFrame("two"));
    });
    await waitFor(() => expect(result.current.events).toHaveLength(2));

    // Reconnect: the server replays the buffer after a new epoch frame.
    act(() => {
      MockEventSource.last!.dispatch(
        "epoch",
        JSON.stringify({ stream_epoch: "e2", expired: false }),
      );
      MockEventSource.last!.dispatch("acp", agentFrame("one"));
      MockEventSource.last!.dispatch("acp", agentFrame("two"));
      MockEventSource.last!.dispatch("acp", agentFrame("three"));
    });
    await waitFor(() => expect(result.current.events).toHaveLength(3));
  });

  it("surfaces the expired flag from the epoch frame", async () => {
    const { result } = renderHook(() => useAcpSession(SID));
    act(() => {
      MockEventSource.last!.dispatch(
        "epoch",
        JSON.stringify({ stream_epoch: "e1", expired: true }),
      );
    });
    await waitFor(() => expect(result.current.expired).toBe(true));
  });

  it("does not open a stream when disabled (pre-ACP archived sessions)", () => {
    const { result } = renderHook(() => useAcpSession(SID, false));
    expect(MockEventSource.instances).toHaveLength(0);
    expect(result.current.streamStatus).toBe("disconnected");
  });

  it("rebuilds a CLOSED stream when the page returns to the foreground", () => {
    renderHook(() => useAcpSession(SID));
    expect(MockEventSource.instances).toHaveLength(1);
    act(() => {
      MockEventSource.last!.readyState = MockEventSource.CLOSED;
      MockEventSource.last!.onerror?.({});
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(MockEventSource.instances).toHaveLength(2);
  });
});
