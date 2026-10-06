import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OakridgeShell } from "../OakridgeShell";
import * as client from "../client";

vi.mock("../hooks/useOakridgeConfig", () => ({ useOakridgeConfig: () => ({ isPending: false, data: { available: true } }) }));
vi.mock("../views/GenericOperatorRunView", () => ({ GenericOperatorRunView: ({ runId }: { readonly runId: string }) => <div>Generic {runId}</div> }));
vi.mock("../components/organisms/RunWorkspace", () => ({ RunWorkspace: ({ runId }: { readonly runId: string }) => <div>Classic {runId}</div> }));
afterEach(() => vi.restoreAllMocks());
it("resets the workspace mode when navigating directly to another run", async () => {
  vi.spyOn(client, "fetchOperatorRun").mockImplementation(async (runId) => ({ run_id: runId, scopes: [] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (runId: string) => <QueryClientProvider client={queryClient}>
    <OakridgeShell route={{ sub: "run", id: runId, pane: null }} />
  </QueryClientProvider>;
  const mounted = render(view("run-1"));
  await screen.findByText("Generic run-1");
  fireEvent.click(screen.getByRole("button", { name: "Classic workspace" }));
  expect(screen.getByText("Classic run-1")).toBeTruthy();
  mounted.rerender(view("run-2"));
  expect(await screen.findByText("Generic run-2")).toBeTruthy();
  expect(screen.queryByText("Classic run-2")).toBeNull();
});
