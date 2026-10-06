import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewInboxView } from "../views/ReviewInboxView";
import type { OperatorInbox } from "../operator-contracts";

afterEach(() => vi.restoreAllMocks());
it("reads definition inbox descriptors and opens their run without issuing a cohort command", async () => {
  const inbox: OperatorInbox = { cursor: [{ scope_id: "scope-1", version: 8 }], items: [
    { kind: "command", run_id: "run-1", scope_id: "scope-1", scope_version: 8, key: "certify_sample", label: "Certify sample", consequence: "Accept this specimen." },
    { kind: "wait", run_id: "run-2", scope_id: "scope-2", scope_version: 2, reason: "dependency", label: "Waiting for sample" },
    { kind: "diagnostic", run_id: "run-3", scope_id: "scope-3", scope_version: 0, detail: "Missing pinned definition" },
  ] };
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(inbox), { headers: { "content-type": "application/json" } }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSelectRun = vi.fn();
  render(<QueryClientProvider client={queryClient}><ReviewInboxView onSelectRun={onSelectRun} onSelectArtifact={() => {}} /></QueryClientProvider>);
  expect(await screen.findByText("Certify sample")).toBeTruthy();
  expect(screen.getByText("Waiting for sample")).toBeTruthy();
  expect(screen.getByText("Missing pinned definition")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Open run" })[0]!);
  expect(onSelectRun).toHaveBeenCalledWith("run-1");
  expect(fetch).toHaveBeenCalledWith("/oakridge/api/api/inbox");
  expect(fetch.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
});


it("renders attention from later pages even when an earlier page has no attention", async () => {
  const pages = [
    { cursor: [{ scope_id: "quiet", version: 0 }], items: [], next_cursor: "second/page?" },
    { cursor: [{ scope_id: "also-quiet", version: 0 }], items: [], next_cursor: "third" },
    { cursor: [{ scope_id: "late", version: 1 }], items: [
      { kind: "command", run_id: "late-run", scope_id: "late", scope_version: 1, key: "accept", label: "Accept later work", consequence: "Accept." },
    ], next_cursor: null },
  ];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(pages.shift()), { headers: { "content-type": "application/json" } }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSelectRun = vi.fn();
  render(<QueryClientProvider client={queryClient}><ReviewInboxView onSelectRun={onSelectRun} onSelectArtifact={() => {}} /></QueryClientProvider>);
  expect(await screen.findByText("Accept later work")).toBeTruthy();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    "/oakridge/api/api/inbox", "/oakridge/api/api/inbox?cursor=second%2Fpage%3F", "/oakridge/api/api/inbox?cursor=third",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Open run" }));
  expect(onSelectRun).toHaveBeenCalledWith("late-run");
  queryClient.clear();
});
