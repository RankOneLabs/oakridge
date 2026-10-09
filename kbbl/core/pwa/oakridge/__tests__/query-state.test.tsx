import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { useRun } from "../hooks/useRun";
import { GenericOperatorRunView } from "../views/GenericOperatorRunView";
import { ReviewInboxView } from "../views/ReviewInboxView";
import { OperatorRunListView } from "../views/OperatorRunListView";
import { OperatorCommandForm } from "../components/organisms/OperatorCommandForm";
import { invalidateOperatorFrame } from "../hooks/useOakridgeInvalidationStream";
import { operatorTransition, runEventFrame } from "../lib/__fixtures__/run-event-frame";
import { useReviewInbox } from "../hooks/useReviewInbox";
import { savePendingCommand } from "../lib/operator-drafts";
import type { OperatorCommandDefinition, OperatorScopeView } from "../operator-contracts";

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

test("one run fetcher uses one key and run invalidation reaches definition and scope", async () => {
  const fetch = vi.fn(async (url: string) => runResponse(url));
  vi.stubGlobal("fetch", fetch);
  const cache = client();
  render(<QueryClientProvider client={cache}><RunConsumer /><GenericOperatorRunView runId="run-one" initialScopeId={null} onBack={() => undefined} /></QueryClientProvider>);
  await screen.findByRole("heading", { name: "Current scope" });
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/runs/run-one"))).toHaveLength(1);
  await cache.invalidateQueries({ queryKey: ["operator", "run-one"] });
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/definition"))).toHaveLength(2);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/scopes/scope-one"))).toHaveLength(2);
});

test("failed refresh retains the last run snapshot behind an error banner", async () => {
  let shouldFail = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => shouldFail && url.endsWith("/runs/run-one")
    ? Response.json({ error: "offline" }, { status: 503 }) : runResponse(url)));
  const cache = client();
  render(<QueryClientProvider client={cache}><GenericOperatorRunView runId="run-one" initialScopeId={null} onBack={() => undefined} /></QueryClientProvider>);
  await screen.findByRole("heading", { name: "Current scope" });
  shouldFail = true;
  await cache.invalidateQueries({ queryKey: ["operator", "run-one"] });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/Refresh failed/));
  expect(screen.getByRole("heading", { name: "Current scope" })).toBeTruthy();
});

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

/** The authority pages GET /api/runs, so a mocked list carries the envelope the client reads. */
const cursorPage = (items: readonly unknown[]): Response => Response.json({ items, next_cursor: null });

function scopeOf(runId: string): string { return `${runId}-scope`; }
/** Serves any run id, so one fan-out can be observed against two runs at once. */
function anyRunResponse(url: string): Response {
  if (url.endsWith("/api/inbox")) return Response.json({ cursor: [], items: [], next_cursor: null });
  if (url.endsWith("/api/runs")) return cursorPage([{ run_id: "run-one", scopes: [{ scope_id: scopeOf("run-one"), label: "One", is_terminal: false }] }]);
  if (url.endsWith("/definition")) return Response.json({ source: { root: "root", schemas: [] } });
  if (url.endsWith("/history")) return Response.json({ transitions: [], facts: [] });
  const runId = url.match(/\/runs\/([^/?]+)/)?.[1] ?? "run-one";
  if (url.endsWith(`/scopes/${scopeOf(runId)}`)) return Response.json({ scope_id: scopeOf(runId), run_id: runId, label: `Scope of ${runId}`,
    state: { schema: "text", data: { kind: "string", value: "snapshot" } }, outcome: null,
    outputs: [], resources: [], executions: [], commands: [], cursor: { scope_version: 1 } });
  return Response.json({ run_id: runId, scopes: [{ scope_id: scopeOf(runId), scope_key: "root", label: `Scope of ${runId}` }] });
}

test("an authority event refreshes its own run and both shared lists, and leaves other runs alone", async () => {
  const fetch = vi.fn(async (url: string) => anyRunResponse(url));
  vi.stubGlobal("fetch", fetch);
  const cache = client();
  render(<QueryClientProvider client={cache}>
    <OperatorRunListView onSelectRun={() => undefined} onNewRun={() => undefined} onDefinitions={() => undefined} onProjects={() => undefined} />
    <ReviewInboxView onSelectScope={() => undefined} />
    <GenericOperatorRunView runId="run-one" initialScopeId={null} onBack={() => undefined} />
    <GenericOperatorRunView runId="run-two" initialScopeId={null} onBack={() => undefined} />
  </QueryClientProvider>);
  await screen.findByRole("heading", { name: "Scope of run-one" });
  await screen.findByRole("heading", { name: "Scope of run-two" });
  expect(await screen.findByText("0/1 scopes complete")).toBeTruthy();
  expect(screen.queryByText(/Error/)).toBeNull();
  const served = (suffix: string) => fetch.mock.calls.filter(([url]) => url.endsWith(suffix)).length;
  expect([served("/api/runs"), served("/api/inbox"), served(`/scopes/${scopeOf("run-two")}`)]).toEqual([1, 1, 1]);

  invalidateOperatorFrame(cache, runEventFrame({ run_id: "run-one", effect: operatorTransition }));

  await waitFor(() => expect([served("/api/runs"), served("/api/inbox"), served(`/scopes/${scopeOf("run-one")}`)]).toEqual([2, 2, 2]));
  expect(served(`/scopes/${scopeOf("run-two")}`)).toBe(1);
});

test("the root scope is displayed even when the server lists a child scope first, and stays through a refetch", async () => {
  let reverse = false;
  const scopes = () => [{ scope_id: "a-child", scope_key: "child", label: "Child" }, { scope_id: "z-root", scope_key: "root", label: "Root" }];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/runs/run-one")) return Response.json({ run_id: "run-one", scopes: reverse ? scopes().reverse() : scopes() });
    if (url.endsWith("/scopes/z-root") || url.endsWith("/scopes/a-child")) {
      const scope_id = url.split("/").pop() ?? "";
      return Response.json({ scope_id, run_id: "run-one", label: scope_id === "z-root" ? "Root scope" : "Child scope",
        state: { schema: "text", data: { kind: "string", value: "s" } }, outcome: null, outputs: [], resources: [], executions: [],
        commands: [], cursor: { scope_version: 1 } });
    }
    return runResponse(url);
  }));
  const cache = client();
  render(<QueryClientProvider client={cache}><GenericOperatorRunView runId="run-one" initialScopeId={null} onBack={() => undefined} /></QueryClientProvider>);
  await screen.findByRole("heading", { name: "Root scope" });
  reverse = true;
  await cache.invalidateQueries({ queryKey: ["operator", "run-one"] });
  expect(screen.getByRole("heading", { name: "Root scope" })).toBeTruthy();
});

test("a failed scope fetch keeps the back button and scope selector and shows the error inline", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/runs/run-one")) return Response.json({ run_id: "run-one", scopes: [
      { scope_id: "scope-one", scope_key: "root", label: "Current scope" }, { scope_id: "broken", scope_key: "child", label: "Broken scope" }] });
    if (url.endsWith("/scopes/broken")) return Response.json({ error: "conflict", detail: "scope is unreadable" }, { status: 500 });
    return runResponse(url);
  }));
  const onBack = vi.fn();
  render(<QueryClientProvider client={client()}><GenericOperatorRunView runId="run-one" initialScopeId={null} onBack={onBack} /></QueryClientProvider>);
  await screen.findByRole("heading", { name: "Current scope" });
  fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "broken" } });
  expect((await screen.findByRole("alert")).textContent).toMatch(/scope is unreadable/);
  expect(screen.getByLabelText<HTMLSelectElement>("Scope").value).toBe("broken");
  fireEvent.click(screen.getByRole("button", { name: "← Runs" }));
  expect(onBack).toHaveBeenCalledOnce();
});
