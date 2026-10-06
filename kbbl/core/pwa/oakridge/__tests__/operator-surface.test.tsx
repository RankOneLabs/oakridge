import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { OperatorLaunchView } from "../views/OperatorLaunchView";
import { OperatorHistoryPane } from "../views/OperatorHistoryPane";
import { OperatorDefinitionEditorView } from "../views/OperatorDefinitionEditorView";

function renderWithQuery(ui: React.ReactElement) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

test("pins the edited JSON definition for a fresh operator database", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/oakridge/api/api/definitions" && init?.method === "GET") return Response.json([]);
    if (url === "/oakridge/api/api/definitions" && init?.method === "POST") return Response.json({ bundle_id: "bundle-1", digest: "sha-1" }, { status: 201 });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const onPinned = vi.fn();
  renderWithQuery(<OperatorDefinitionEditorView cloneFromId={null} onBack={() => undefined} onPinned={onPinned} />);
  fireEvent.click(screen.getByRole("button", { name: "Pin definition" }));
  await waitFor(() => expect(onPinned).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toHaveProperty("root");
});

test("launches a run using the pinned digest and entered root input", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/oakridge/api/api/definitions") return Response.json([{ bundle_id: "bundle-1", digest: "sha-1", source: { key: "demo", version: 1 } }]);
    if (url === "/oakridge/api/runs" && init?.method === "POST") return Response.json({ run_id: "run-1" }, { status: 201 });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const onCreated = vi.fn();
  renderWithQuery(<OperatorLaunchView onBack={() => undefined} onCreated={onCreated} onEdit={() => undefined} />);
  await screen.findByText(/demo v1/);
  fireEvent.change(screen.getByLabelText("Root input JSON"), { target: { value: '{"request":"hello"}' } });
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("run-1"));
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ digest: "sha-1", input: { request: "hello" } });
});

test("history shows transitions and facts without exposing execution secrets", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ scope_id: "scope-1",
    transitions: [{ id: "transition-1", trigger_id: "trigger-1", version: 2, created_at: "2026-01-01T00:00:00Z", decision: { kind: "apply", publication_secret: "hidden" } }],
    facts: [{ id: "fact-1", fact_key: "reviewed", payload: { schema: "text", data: { kind: "string", value: "approved" } } }] })));
  renderWithQuery(<OperatorHistoryPane runId="run-1" scopeId="scope-1" schemas={[]} />);
  expect(await screen.findByText(/Version 2 · apply/)).toBeTruthy();
  expect(screen.getByText("reviewed")).toBeTruthy();
  expect(screen.getByText("approved")).toBeTruthy();
  expect(screen.queryByText("hidden")).toBeNull();
});
