import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveSubscription } from "./live-stream";
import type { LiveStreamFrame } from "../../live-stream";

class EventSourceStub {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: EventSourceStub[] = [];
  readyState = EventSourceStub.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, EventListener>();
  constructor(readonly url: string) { EventSourceStub.instances.push(this); }
  addEventListener(name: string, listener: EventListener): void { this.listeners.set(name, listener); }
  close(): void { this.readyState = EventSourceStub.CLOSED; }
  emit(frame: LiveStreamFrame): void { this.listeners.get("live")?.(new MessageEvent("live", { data: JSON.stringify(frame) })); }
}

let subscriptions: LiveSubscription[];
const subscribe = (topic: ConstructorParameters<typeof LiveSubscription>[0]): LiveSubscription => {
  const subscription = new LiveSubscription(topic);
  subscriptions.push(subscription);
  return subscription;
};
const activeSources = (): EventSourceStub[] => EventSourceStub.instances.filter((source) => source.readyState !== EventSourceStub.CLOSED);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", EventSourceStub);
  EventSourceStub.instances = [];
  subscriptions = [];
});
afterEach(() => {
  subscriptions.forEach((subscription) => subscription.close());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("one live connection per page", () => {
  it("retains the Oakridge cursor across pane changes without adopting session ids or late events", () => {
    subscribe("/oakridge/api/events");
    const original = activeSources()[0];
    original.emit({ topic: "/oakridge/api/events", frame: { event: "run_event", data: "{}", id: "42" } });
    const session = subscribe("/sessions/first/stream");
    original.emit({ topic: "/oakridge/api/events", frame: { event: "run_event", data: "{}", id: "stale" } });
    vi.runOnlyPendingTimers();
    const withPane = activeSources()[0];
    withPane.emit({ topic: session.topic, frame: { event: "acp", data: "{}", id: "99" } });
    session.close();
    vi.runOnlyPendingTimers();
    expect([withPane, activeSources()[0]].map((source) => new URL(source.url, "http://localhost").searchParams.get("oakridge_cursor"))).toEqual(["42", "42"]);
  });

  it("discards the cursor when the last Oakridge subscription leaves", () => {
    subscribe("/inbox");
    const oakridge = subscribe("/oakridge/api/events");
    vi.runOnlyPendingTimers();
    activeSources()[0].emit({ topic: oakridge.topic, frame: { event: "invalidate", data: "{}", id: "42" } });
    oakridge.close();
    subscribe("/oakridge/api/events");
    vi.runOnlyPendingTimers();
    expect(new URL(activeSources()[0].url, "http://localhost").searchParams.has("oakridge_cursor")).toBe(false);
  });

  it("combines inbox, Oakridge and two session panes into one browser connection", () => {
    subscribe("/inbox");
    subscribe("/oakridge/api/events");
    subscribe("/sessions/first/stream");
    subscribe("/sessions/second/stream");
    vi.runOnlyPendingTimers();
    expect(activeSources().map((source) => new URL(source.url, "http://localhost").searchParams.getAll("topic"))).toEqual([
      ["/inbox", "/oakridge/api/events", "/sessions/first/stream", "/sessions/second/stream"],
    ]);
  });

  it("routes replay and live frames only to their session, retaining event ids", () => {
    const first = subscribe("/sessions/first/stream");
    const second = subscribe("/sessions/second/stream");
    const received: string[] = [];
    first.addEventListener("epoch", (event) => received.push(`first:${event.data}`));
    first.addEventListener("acp", (event) => received.push(`first:${event.lastEventId}:${event.data}`));
    second.addEventListener("acp", (event) => received.push(`second:${event.data}`));
    vi.runOnlyPendingTimers();
    const source = activeSources()[0];
    source.emit({ topic: first.topic, frame: { event: "epoch", data: "new epoch" } });
    source.emit({ topic: first.topic, frame: { event: "acp", id: "7", data: "replay" } });
    source.emit({ topic: second.topic, frame: { event: "acp", data: "live" } });
    expect(received).toEqual(["first:new epoch", "first:7:replay", "second:live"]);
  });

  it("removes a closed pane from the feed and ignores late frames from the replaced connection", () => {
    subscribe("/inbox");
    const session = subscribe("/sessions/first/stream");
    const received: string[] = [];
    session.addEventListener("acp", (event) => received.push(event.data));
    vi.runOnlyPendingTimers();
    const oldSource = activeSources()[0];
    session.close();
    oldSource.emit({ topic: session.topic, frame: { event: "acp", data: "stale" } });
    vi.runOnlyPendingTimers();
    expect({ received, topics: new URL(activeSources()[0].url, "http://localhost").searchParams.getAll("topic") }).toEqual({ received: [], topics: ["/inbox"] });
  });

  it("reconnects with every topic when a closed connection is foregrounded", () => {
    const inbox = subscribe("/inbox");
    const session = subscribe("/sessions/first/stream");
    const opened = vi.fn();
    inbox.onopen = opened;
    session.onopen = opened;
    vi.runOnlyPendingTimers();
    activeSources()[0].close();
    window.dispatchEvent(new Event("focus"));
    const source = activeSources()[0];
    source.onopen?.(new Event("open"));
    expect({ topics: new URL(source.url, "http://localhost").searchParams.getAll("topic"), opened: opened.mock.calls.length }).toEqual({ topics: ["/inbox", "/sessions/first/stream"], opened: 2 });
  });

  it("keeps a duplicate session subscription after one pane closes", () => {
    const first = subscribe("/sessions/first/stream");
    const second = subscribe("/sessions/first/stream");
    const received = vi.fn();
    second.addEventListener("acp", received);
    vi.runOnlyPendingTimers();
    first.close();
    activeSources()[0].emit({ topic: second.topic, frame: { event: "acp", data: "new output" } });
    expect(received).toHaveBeenCalledOnce();
  });

  it("closes the browser connection when its last consumer leaves", () => {
    const inbox = subscribe("/inbox");
    inbox.close();
    vi.runOnlyPendingTimers();
    expect(activeSources()).toEqual([]);
  });
});
