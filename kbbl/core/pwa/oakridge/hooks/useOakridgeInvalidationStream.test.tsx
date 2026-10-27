import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { CohortLifecycleSummary, ReviewInbox } from "../types";
import { useOakridgeInvalidationStream } from "./useOakridgeInvalidationStream";

const pending = vi.hoisted(() => ({ resolutions: [] as Array<(inbox: ReviewInbox) => void> }));
vi.mock("../client", () => ({
  invalidateCachedRunUnits: vi.fn(),
  parseOakridgeRunEventFrame: vi.fn(() => null),
  refreshReviewInboxRun: vi.fn(() => new Promise<ReviewInbox>((resolve) => { pending.resolutions.push(resolve); })),
}));
vi.mock("../adapters/inbox", () => ({
  replaceDevelopmentInboxRun: (_latest: ReviewInbox, _runId: string, updated: ReviewInbox) => updated,
}));

class EventSourceStub {
  static instances: EventSourceStub[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  constructor(readonly url: string) { EventSourceStub.instances.push(this); }
  addEventListener(name: string, listener: EventListener): void {
    const listeners = this.listeners.get(name) ?? new Set<EventListener>();
    listeners.add(listener); this.listeners.set(name, listeners);
  }
  removeEventListener(name: string, listener: EventListener): void { this.listeners.get(name)?.delete(listener); }
  close(): void {}
  emit(name: string, data: string): void {
    const frame = JSON.stringify({ topic: "/oakridge/api/events", frame: { event: name, data } });
    for (const listener of this.listeners.get("live") ?? []) listener(new MessageEvent("live", { data: frame }));
  }
}

afterEach(() => { vi.unstubAllGlobals(); EventSourceStub.instances = []; pending.resolutions = []; });

test("normal run events refresh the inbox and an older response cannot overwrite the newer slice", async () => {
  vi.stubGlobal("EventSource", EventSourceStub);
  const client = new QueryClient();
  client.setQueryData<ReviewInbox>(["oakridge", "review-inbox"], { cohorts: [], items: [] });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useOakridgeInvalidationStream(true), { wrapper });
  const source = EventSourceStub.instances[0];
  act(() => { source?.emit("run_event", JSON.stringify({ run_id: "run-1" })); });
  act(() => { source?.emit("run_event", JSON.stringify({ run_id: "run-1" })); });
  expect(pending.resolutions).toHaveLength(2);
  const older: ReviewInbox = { cohorts: [], items: [] };
  const newer: ReviewInbox = { cohorts: [{ id: "new-review", run_id: "run-1", workflow_name: "development",
    stage_instance_id: "stage", stage_name: "cohort", unit_id: "unit", cohort_key: "unit", brief_title: null,
    repository_key: "oakridge" as CohortLifecycleSummary["repository_key"], lifecycle: "merge_confirmation",
    completion: { build_complete: true, assessment_complete: true },
    updated_at: "2026-10-16T00:00:00Z" }], items: [] };
  await act(async () => { pending.resolutions[1]?.(newer); await Promise.resolve(); });
  await act(async () => { pending.resolutions[0]?.(older); await Promise.resolve(); });
  expect(client.getQueryData<ReviewInbox>(["oakridge", "review-inbox"])?.cohorts.map((cohort) => cohort.id)).toEqual(["new-review"]);
  hook.unmount(); client.clear();
});
