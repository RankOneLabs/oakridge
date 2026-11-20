import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { EMPTY_SESSION_LIVE_STATE, transcriptItemId, transcriptSeq, type AgentMessageItem } from "../../acp/transcript-model";
import type { SessionEpochFrame } from "../types";
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
    const topic = new URL(this.url, "http://localhost").searchParams.get("topic");
    for (const cb of this.listeners.live ?? []) cb({ data: JSON.stringify({ topic, frame: { event: type, data } }) });
  }
  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }
}

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";

function epochFrame(overrides: Partial<SessionEpochFrame> = {}): string {
  return JSON.stringify({
    kind: "epoch", stream_epoch: "e1", history_kind: "transcript", expired: false, summary: null,
    open_turns: [], session_state: EMPTY_SESSION_LIVE_STATE, items: [], has_earlier: false, is_truncated: false,
    ...overrides,
  });
}

function agentItem(index: number, text: string): AgentMessageItem {
  const seq = transcriptSeq(index);
  return { kind: "agent_message", id: transcriptItemId(seq), seq, message_id: null, text, is_streaming: true, is_replayed: false };
}

function agentFrame(seq: number, text: string): string {
  return JSON.stringify({ kind: "item", item: agentItem(seq, text) });
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

  it("appends item frames after the epoch frame", async () => {
    const { result } = renderHook(() => useAcpSession(SID));
    act(() => {
      MockEventSource.last!.dispatch(
        "epoch",
        epochFrame(),
      );
      MockEventSource.last!.dispatch("item", agentFrame(0, "hello"));
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.expired).toBe(false);
  });

  it("a fresh epoch frame resets the accumulated timeline (reconnect replay)", async () => {
    const { result } = renderHook(() => useAcpSession(SID));
    act(() => {
      MockEventSource.last!.dispatch(
        "epoch",
        epochFrame(),
      );
      MockEventSource.last!.dispatch("item", agentFrame(0, "one"));
      MockEventSource.last!.dispatch("item", agentFrame(1, "two"));
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    // The next epoch replaces rendered items and cancels pending deltas.
    act(() => {
      MockEventSource.last!.dispatch("item", agentFrame(2, "discarded"));
      MockEventSource.last!.dispatch("epoch", epochFrame({ items: [agentItem(0, "fresh")] }));
    });
    expect(result.current.items.map((item) => item.id)).toEqual(["item-0"]);
    expect(result.current.items[0]).toMatchObject({ text: "fresh" });
    expect(result.current.transcriptVersion).toBe(3);
  });

  it("surfaces the expired flag from the epoch frame", async () => {
    const { result } = renderHook(() => useAcpSession(SID));
    act(() => {
      MockEventSource.last!.dispatch(
        "epoch",
        epochFrame({ history_kind: "unavailable", expired: true }),
      );
    });
    await waitFor(() => expect(result.current.expired).toBe(true));
  });

  it("hydrates a persisted terminal summary from the epoch frame", async () => {
    const { result } = renderHook(() => useAcpSession(SID));
    act(() => {
      MockEventSource.last!.dispatch(
        "epoch",
        epochFrame({
          stream_epoch: null,
          history_kind: "summary",
          expired: true,
          summary: {
            schema_version: 1,
            session_id: SID as import("../../acp/types").KbblSessionId,
            method: "final_response",
            produced_at: "2026-09-23T00:00:00.000Z",
            markdown: "Recovered result",
            created_at: "2026-09-23T00:00:01.000Z",
            updated_at: "2026-09-23T00:00:01.000Z",
          },
        }),
      );
    });
    await waitFor(() => expect(result.current.summary?.markdown).toBe("Recovered result"));
    expect(result.current.unavailableReason).toBeNull();
  });

  it("hydrates durable open turns and reports history readiness from epoch", async () => {
    const { result } = renderHook(() => useAcpSession(SID));
    act(() => {
      MockEventSource.last!.dispatch(
        "epoch",
        epochFrame({
          expired: false,
          open_turns: [{
            turnKey: "operator:queued" as import("../types").TurnKey,
            source: "operator",
            text: "queued input",
            status: "accepted",
            createdAt: "2026-09-02T00:00:00.000Z",
          }],
        }),
      );
    });
    await waitFor(() => expect(result.current.historyLoaded).toBe(true));
    expect(result.current.openTurns).toHaveLength(1);
  });

  it("surfaces an in-band stream_error after early SSE readiness", async () => {
    const { result } = renderHook(() => useAcpSession(SID));
    act(() => {
      MockEventSource.last!.dispatch(
        "stream_error",
        JSON.stringify({ kind: "stream_error", error: "history load failed", code: "acp_session_load_failed" }),
      );
    });
    await waitFor(() => expect(result.current.streamError).toBe("history load failed"));
  });

  it.each([
    { error: "session not found", code: "session_not_found" },
    { error: "upstream disconnected" },
  ])("surfaces relay errors without a session frame kind ($error)", async (payload) => {
    const { result } = renderHook(() => useAcpSession(SID));
    act(() => MockEventSource.last!.dispatch("stream_error", JSON.stringify(payload)));
    await waitFor(() => expect(result.current.streamError).toBe(payload.error));
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
