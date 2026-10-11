import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { makeRunDetail, makeScopeView } from "../__fixtures__/read-models";
import { RunWorkspace } from "../components/organisms/RunWorkspace";
import { PlanGraph } from "../components/molecules/PlanGraph";
import { selectPendingCommandsForRecovery } from "../lib/run-attention";
import { operatorDraftIdentity, savePendingCommand, type OperatorCommandSubmission } from "../lib/operator-drafts";
import { queryKeys } from "../queryKeys";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

test("an uncertain command becomes recoverable after the scope projection advances", () => {
  const submission: OperatorCommandSubmission = { run_id: "run-1", scope_id: "scope-1", command_key: "approve",
    owner_version: 1, targets: [], payload: {}, request_id: "stable-request" };
  const attempted = new Map([[operatorDraftIdentity(submission), 1]]);
  const candidates = selectPendingCommandsForRecovery({ pending: [submission],
    scopes: [makeScopeView({ cursor: { scope_version: 2, transition_id: null } })],
    attemptedScopeVersions: attempted, inFlight: new Set() });
  expect(candidates).toEqual([submission]);
});

test("workspace retries an uncertain command with its retained request id after a newer projection", async () => {
  const submission: OperatorCommandSubmission = { run_id: "run-1", scope_id: "scope-1", command_key: "approve",
    owner_version: 1, targets: [], payload: {}, request_id: "stable-request" };
  savePendingCommand(submission);
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)).request_id as string);
      return posts.length === 1 ? Response.json({ detail: "uncertain" }, { status: 503 })
        : Response.json({ kind: "accepted_pending", request_id: "stable-request", transition_id: "transition-1", scope_version: 2 });
    }
    if (url.endsWith("/runs/run-1")) return Response.json(makeRunDetail({ scopes: [
      { scope_id: "scope-1", scope_key: "development", label: "Development", version: 1,
        is_terminal: false, available_commands: [] },
    ] }));
    if (url.endsWith("/definition")) return Response.json({ source: { root: "development", schemas: [] } });
    if (url.endsWith("/history")) return Response.json({ transitions: [], facts: [] });
    if (url.endsWith("/scopes/scope-1")) return Response.json(makeScopeView());
    throw new Error(url);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RunWorkspace runId="run-1" routePane={null} scopeId="scope-1" onBack={() => undefined} /></QueryClientProvider>);
  await waitFor(() => expect(posts).toHaveLength(1));
  await screen.findByText(/approve: uncertain/);
  client.setQueryData(queryKeys.scope("run-1", "scope-1"), makeScopeView({ cursor: { scope_version: 2, transition_id: null } }));
  await waitFor(() => expect(posts).toEqual(["stable-request", "stable-request"]));
});

test("a failed selected-scope request shows the failure instead of loading forever", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/runs/run-1")) return Response.json(makeRunDetail({ scopes: [
      { scope_id: "scope-1", scope_key: "development", label: "Development", version: 1,
        is_terminal: false, available_commands: [] },
    ] }));
    if (url.endsWith("/definition")) return Response.json({ source: { root: "development", schemas: [] } });
    if (url.endsWith("/scopes/scope-1")) return Response.json({ detail: "projection unavailable" }, { status: 503 });
    throw new Error(url);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RunWorkspace runId="run-1" routePane={null} scopeId="scope-1" onBack={() => undefined} /></QueryClientProvider>);
  expect((await screen.findByText(/Could not load scope:.*projection unavailable/)).getAttribute("role")).toBe("alert");
});

test("graph nodes activate with Space", () => {
  const onSelect = vi.fn();
  render(<PlanGraph layout={{ width: 320, height: 150, edges: [], nodes: [
    { id: "cohort-1", title: "Build", depends_on: [], x: 24, y: 36,
      cohort: { schema: "text", data: { kind: "string", value: "Build" } } },
  ] }} selectedId={null} onSelect={onSelect} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "cohort-1 Build" }), { key: " " });
  expect(onSelect).toHaveBeenCalledWith("cohort-1");
});
