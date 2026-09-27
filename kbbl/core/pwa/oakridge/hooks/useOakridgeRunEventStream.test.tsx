import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { useOakridgeInvalidationStream } from "./useOakridgeInvalidationStream";
import { useOakridgeRunEventStream } from "./useOakridgeRunEventStream";
import type { RunEvent } from "../types";

class EventSourceStub {
  static instances: EventSourceStub[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  constructor(readonly url: string) { EventSourceStub.instances.push(this); }
  addEventListener(name: string, listener: EventListener): void {
    const set = this.listeners.get(name) ?? new Set<EventListener>(); set.add(listener); this.listeners.set(name, set);
  }
  removeEventListener(name: string, listener: EventListener): void { this.listeners.get(name)?.delete(listener); }
  close(): void {}
  emit(name: string, data: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data }));
  }
}

afterEach(() => { vi.unstubAllGlobals(); EventSourceStub.instances = []; });

test("invalidation and typed run-event hooks share one EventSource and replayed events stay silent", () => {
  vi.stubGlobal("EventSource", EventSourceStub);
  const client = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const received: RunEvent[] = [];
  const hook = renderHook(() => {
    useOakridgeInvalidationStream(true);
    useOakridgeRunEventStream(true, (event) => received.push(event));
  }, { wrapper });
  expect(EventSourceStub.instances).toHaveLength(1);
  const source = EventSourceStub.instances[0];
  const frame = { sequence: "7", operation: "gate_opened", occurred_at: "2026-09-26T12:00:00.000Z",
    payload: { run_id: "run", run_unit_id: null, stage_instance_id: null, stage_key: null, unit_id: null,
      work_order_id: null, wait_id: null, output_name: null, collection_key: null, artifact_revision_id: null,
      attention: null, continuation: null, detail: {} } };
  act(() => { source?.emit("run_event", JSON.stringify({ ...frame, replayed: true })); });
  act(() => { source?.emit("run_event", JSON.stringify({ ...frame, sequence: "8", replayed: false })); });
  expect(received.map((event) => event.sequence)).toEqual(["8"]);
  hook.unmount();
});
