import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { useRun } from "../hooks/useRun";
import { ReviewInboxView } from "../views/ReviewInboxView";
import { OperatorCommandForm } from "../components/organisms/OperatorCommandForm";
import { invalidateOperatorFrame } from "../hooks/useOakridgeInvalidationStream";
import { useOakridgeInvalidationStream } from "../hooks/useOakridgeInvalidationStream";
import { useOakridgeRunEventStream } from "../hooks/useOakridgeRunEventStream";
import { selectEventNotification } from "../lib/run-notifications";
import { operatorEvent } from "../lib/__fixtures__/operator-event";
import { useReviewInbox } from "../hooks/useReviewInbox";
import { savePendingCommand } from "../lib/operator-drafts";
import type { OperatorCommandDefinition, OperatorScopeView } from "../operator-contracts";
import type { LiveStreamFrame } from "../../../live-stream";

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
  emit(frame: LiveStreamFrame): void { this.listeners.get("live")?.(new MessageEvent("live", { data: JSON.stringify(frame) })); }
}

function StreamConsumer({ onToast, cache }: { readonly onToast: (toast: unknown) => void; readonly cache: QueryClient }) {
  useOakridgeInvalidationStream(true);
  useOakridgeRunEventStream(true, (event) => {
    invalidateOperatorFrame(cache, event);
    const toast = selectEventNotification(event);
    if (toast) onToast(toast);
  });
  return null;
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

function RunConsumer() { useRun("run-one"); return null; }
function InboxConsumer() { useReviewInbox(); return null; }
function runResponse(url: string): Response {
  if (url.endsWith("/runs/run-one")) return Response.json({ run_id: "run-one", scopes: [{ scope_id: "scope-one", scope_key: "root", label: "Current scope" }] });
  if (url.endsWith("/definition")) return Response.json({ source: { root: "root", schemas: [] } });
  if (url.endsWith("/history")) return Response.json({ transitions: [], facts: [] });
  return Response.json({ scope_id: "scope-one", run_id: "run-one", label: "Current scope",
    state: { schema: "text", data: { kind: "string", value: "snapshot" } }, outcome: null,
    outputs: [], resources: [], executions: [], commands: [], cursor: { scope_version: 1 } });
}

test("the app badge and visible inbox share one fetch and one invalidation key", async () => {
  const fetch = vi.fn(async () => Response.json({ cursor: [], items: [], next_cursor: null }));
  vi.stubGlobal("fetch", fetch);
  const cache = client();
  render(<QueryClientProvider client={cache}><InboxConsumer />
    <ReviewInboxView onSelectScope={() => undefined} /></QueryClientProvider>);
  await screen.findByText("Nothing needs attention.");
  expect(fetch).toHaveBeenCalledTimes(1);
  await cache.invalidateQueries({ queryKey: ["operator", "inbox"] });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

test("StrictMode recovery delivers one pending command with its retained request id", async () => {
  const command = { key: "action", label: "Act", consequence: "Continue", payload_schema: "empty",
    available_in: [], required: true, field_presentation: [], targets: [] } satisfies OperatorCommandDefinition;
  const scope = { run_id: "run-one", scope_id: "scope-one", commands: [command], outputs: [],
    cursor: { scope_version: 1, transition_id: null }, command_targets: { action: [] }, command_prefill: {}, resources: [] } as unknown as OperatorScopeView;
  savePendingCommand({ run_id: "run-one", scope_id: "scope-one", command_key: "action", owner_version: 1,
    targets: [], request_id: "stable-id", payload: {} });
  let complete: (value: Response) => void = () => undefined;
  const response = new Promise<Response>((resolve) => { complete = resolve; });
  const fetch = vi.fn((_url: string, _init?: RequestInit) => response);
  vi.stubGlobal("fetch", fetch);
  render(<StrictMode><OperatorCommandForm scope={scope} command={command} schemas={[]} onRefresh={() => undefined} /></StrictMode>);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).request_id).toBe("stable-id");
  complete(Response.json({ kind: "accepted_pending", request_id: "stable-id", transition_id: "transition", scope_version: 2 }));
  await screen.findByText("Command accepted.");
});

test("replayed authority frames refresh queries without toasts; session snapshots refresh only sessions", async () => {
  EventSourceStub.instances = [];
  vi.stubGlobal("EventSource", EventSourceStub);
  const cache = client();
  const invalidations = vi.spyOn(cache, "invalidateQueries");
  const onToast = vi.fn();
  const mounted = render(<QueryClientProvider client={cache}><StreamConsumer cache={cache} onToast={onToast} /></QueryClientProvider>);
  await waitFor(() => expect(EventSourceStub.instances.some((source) => source.readyState !== EventSourceStub.CLOSED)).toBe(true));
  const source = EventSourceStub.instances.findLast((item) => item.readyState !== EventSourceStub.CLOSED);
  if (!source) throw new Error("live source did not connect");
  source.emit({ topic: "/oakridge/api/events", frame: { event: "run_event", id: "first", data: JSON.stringify({ ...operatorEvent(), replay: true }) } });
  expect(invalidations.mock.calls.map(([filter]) => filter?.queryKey)).toEqual([
    ["operator", "run-one"], ["operator", "runs"], ["operator", "inbox"],
  ]);
  expect(onToast).not.toHaveBeenCalled();
  invalidations.mockClear();
  source.emit({ topic: "/oakridge/api/events", frame: { event: "invalidate", id: "second", data: JSON.stringify({ kind: "invalidate", target: "projects", run_id: null, replay: true }) } });
  expect(invalidations.mock.calls.map(([filter]) => filter?.queryKey)).toEqual([["operator", "projects"]]);
  expect(onToast).not.toHaveBeenCalled();
  invalidations.mockClear();
  source.emit({ topic: "/inbox", frame: { event: "snapshot", data: JSON.stringify({ sessions: [] }) } });
  expect(invalidations.mock.calls.map(([filter]) => filter?.queryKey)).toEqual([["sessions"]]);
  expect(onToast).not.toHaveBeenCalled();
  mounted.unmount();
});

test("a session snapshot does not refetch an active run", async () => {
  EventSourceStub.instances = [];
  vi.stubGlobal("EventSource", EventSourceStub);
  const fetch = vi.fn(async (url: string) => runResponse(url));
  vi.stubGlobal("fetch", fetch);
  const cache = client();
  const mounted = render(<QueryClientProvider client={cache}><RunConsumer /><StreamConsumer cache={cache} onToast={() => undefined} /></QueryClientProvider>);
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith("/runs/run-one"))).toHaveLength(1));
  await waitFor(() => expect(EventSourceStub.instances.some((source) => source.readyState !== EventSourceStub.CLOSED)).toBe(true));
  const source = EventSourceStub.instances.findLast((item) => item.readyState !== EventSourceStub.CLOSED);
  if (!source) throw new Error("live source did not connect");
  source.emit({ topic: "/inbox", frame: { event: "snapshot", data: JSON.stringify({ sessions: [] }) } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/runs/run-one"))).toHaveLength(1);
  mounted.unmount();
});
