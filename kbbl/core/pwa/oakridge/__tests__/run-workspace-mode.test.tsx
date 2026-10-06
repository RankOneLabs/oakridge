import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OakridgeShell } from "../OakridgeShell";
vi.mock("../hooks/useOakridgeConfig", () => ({ useOakridgeConfig: () => ({ isPending: false, data: { available: true } }) }));
vi.mock("../views/GenericOperatorRunView", () => ({ GenericOperatorRunView: ({ runId }: { readonly runId: string }) => <div>Generic {runId}</div> }));
afterEach(() => vi.restoreAllMocks());
it("run routes expose only definition commands, including former artifact links", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (runId: string) => <QueryClientProvider client={client}>
    <OakridgeShell route={{ sub: "run", id: runId, pane: { kind: "artifact", artifact_id: "artifact-1" as import("../../lib/ids").ArtifactId } }} />
  </QueryClientProvider>;
  const mounted = render(view("run-1"));
  expect(await screen.findByText("Generic run-1")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Classic workspace" })).toBeNull();
  mounted.rerender(view("run-2"));
  expect(await screen.findByText("Generic run-2")).toBeTruthy();
});
