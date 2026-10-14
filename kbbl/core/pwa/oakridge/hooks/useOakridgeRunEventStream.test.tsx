// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { LiveStreamFrame } from "../../../live-stream";
import { makeRunEvent } from "../__fixtures__/read-models";
import type { OperatorRunEvent } from "../operator-contracts";
import { queryKeys } from "../queryKeys";
import { useOakridgeInvalidationStream } from "./useOakridgeInvalidationStream";
import { useOakridgeRunEventStream } from "./useOakridgeRunEventStream";

class EventSourceStub {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: EventSourceStub[] = [];
  readyState = EventSourceStub.OPEN;
  private readonly listeners = new Map<string, EventListener>();
  constructor(readonly url: string) { EventSourceStub.instances.push(this); }
  addEventListener(name: string, listener: EventListener): void { this.listeners.set(name, listener); }
  close(): void { this.readyState = EventSourceStub.CLOSED; }
  emit(frame: LiveStreamFrame): void {
    this.listeners.get("live")?.(new MessageEvent("live", { data: JSON.stringify(frame) }));
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); EventSourceStub.instances = []; });

test("invalidation and run-event hooks share a source while replay refreshes without a live notification", async () => {
  vi.stubGlobal("EventSource", EventSourceStub);
  const client = new QueryClient();
  const invalidations = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const received: OperatorRunEvent[] = [];
  const hook = renderHook(() => {
    useOakridgeInvalidationStream(true, Number.POSITIVE_INFINITY);
    useOakridgeRunEventStream(true, (event) => received.push(event));
  }, { wrapper });
  await waitFor(() => expect(EventSourceStub.instances.filter((source) => source.readyState !== EventSourceStub.CLOSED)).toHaveLength(1));
  const source = EventSourceStub.instances.find((item) => item.readyState !== EventSourceStub.CLOSED);
  expect(source?.url.match(/topic=%2Foakridge%2Fapi%2Fevents/g)).toHaveLength(1);
  const replay = makeRunEvent({ event_id: "event-7" });
  const live = makeRunEvent({ event_id: "event-8" });
  act(() => {
    source?.emit({ topic: "/oakridge/api/events", frame: { event: "run_event", data: JSON.stringify({ ...replay, replay: true }) } });
    source?.emit({ topic: "/oakridge/api/events", frame: { event: "run_event", data: JSON.stringify({ ...live, replay: false }) } });
  });
  expect(received.map((event) => event.event_id)).toEqual(["event-8"]);
  expect(invalidations).toHaveBeenCalledWith({ queryKey: queryKeys.run("run-one") });
  hook.unmount();
});

