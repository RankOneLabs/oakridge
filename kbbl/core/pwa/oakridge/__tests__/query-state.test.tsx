import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { useRun } from "../hooks/useRun";
import { GenericOperatorRunView } from "../views/GenericOperatorRunView";
import { ReviewInboxView } from "../views/ReviewInboxView";
import { OperatorCommandForm } from "../components/organisms/OperatorCommandForm";
import { useReviewInbox } from "../hooks/useReviewInbox";
import { savePendingCommand } from "../lib/operator-drafts";
import type { OperatorCommandDescriptor, OperatorScopeView } from "../operator-contracts";

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

function RunConsumer() { useRun("run-one"); return null; }
function InboxConsumer() { useReviewInbox(); return null; }
function runResponse(url: string): Response {
  if (url.endsWith("/runs/run-one")) return Response.json({ run_id: "run-one", scopes: [{ scope_id: "scope-one", label: "Current scope" }] });
  if (url.endsWith("/definition")) return Response.json({ source: { schemas: [] } });
  if (url.endsWith("/history")) return Response.json({ transitions: [], facts: [] });
  return Response.json({ scope_id: "scope-one", run_id: "run-one", label: "Current scope",
    state: { schema: "text", data: { kind: "string", value: "snapshot" } }, outcome: null,
    outputs: [], executions: [], commands: [], cursor: { scope_version: 1 } });
}

test("one run fetcher uses one key and run invalidation reaches definition and scope", async () => {
  const fetch = vi.fn(async (url: string) => runResponse(url));
  vi.stubGlobal("fetch", fetch);
  const cache = client();
  render(<QueryClientProvider client={cache}><RunConsumer /><GenericOperatorRunView runId="run-one" onBack={() => undefined} /></QueryClientProvider>);
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
  render(<QueryClientProvider client={cache}><GenericOperatorRunView runId="run-one" onBack={() => undefined} /></QueryClientProvider>);
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
    <ReviewInboxView onSelectRun={() => undefined} onSelectArtifact={() => undefined} /></QueryClientProvider>);
  await screen.findByText("Nothing needs attention.");
  expect(fetch).toHaveBeenCalledTimes(1);
  await cache.invalidateQueries({ queryKey: ["operator", "inbox"] });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

test("StrictMode recovery delivers one pending command with its retained request id", async () => {
  const command = { key: "action", label: "Act", consequence: "Continue", payload_schema: "empty",
    field_presentation: [], targets: [] } as OperatorCommandDescriptor;
  const scope = { run_id: "run-one", scope_id: "scope-one", commands: [command], outputs: [],
    cursor: { scope_version: 1, transition_id: null }, command_targets: { action: [] } } as unknown as OperatorScopeView;
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
