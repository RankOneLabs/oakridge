import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { useOakridgeInvalidationStream } from "./useOakridgeInvalidationStream";
import { useOakridgeRunEventStream } from "./useOakridgeRunEventStream";
import type { RunEventFrame } from "../types";

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

test("invalidation and typed run-event hooks share one EventSource and deliver replay metadata", () => {
  vi.stubGlobal("EventSource", EventSourceStub);
  const client = new QueryClient();
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const received: RunEventFrame[] = [];
  const hook = renderHook(() => {
    useOakridgeInvalidationStream(true);
    useOakridgeRunEventStream(true, (event) => received.push(event));
  }, { wrapper });
  expect(EventSourceStub.instances).toHaveLength(1);
  const source = EventSourceStub.instances[0];
  const frame = { sequence: "7", transition_id: "transition-7", run_id: "run",
    owner: { kind: "stage_instance", id: "stage" }, launch_reason: "initial",
    prior_owner_version: 0, resulting_owner_version: 1,
    effect: { kind: "start_stage", stage_instance_id: "stage" }, effect_workflow_id: null,
    actor: "core", occurred_at: "2026-09-26T12:00:00.000Z" };
  act(() => { source?.emit("run_event", JSON.stringify({ ...frame, replayed: true })); });
  act(() => { source?.emit("run_event", JSON.stringify({ ...frame, sequence: "8", replayed: false })); });
  expect(received.map((event) => [event.sequence, event.replayed])).toEqual([
    ["7", true],
    ["8", false],
  ]);
  hook.unmount();
});
