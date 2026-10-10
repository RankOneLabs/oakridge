import { afterEach, expect, test, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ArtifactId, Sid } from "../../lib/ids";
import type { OperatorExecutionView, OperatorOutputSlotView } from "../operator-contracts";
import { makeRunDetail, makeScopeView } from "../__fixtures__/read-models";
import { ArtifactWorkspaceRedirectView } from "../views/ArtifactWorkspaceRedirectView";
import { SessionWorkspaceRedirectView } from "../views/SessionWorkspaceRedirectView";

afterEach(() => { vi.unstubAllGlobals(); history.replaceState(null, "", "#oakridge"); });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const run = makeRunDetail({ scopes: [{ scope_id: "scope-1", scope_key: "development", label: "Development",
  version: 1, is_terminal: false, available_commands: [] }] });

function stubProjection(scope: ReturnType<typeof makeScopeView>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/api/runs")) return Response.json({ items: [run], next_cursor: null });
    if (url.includes("?archived=true")) return Response.json({ items: [], next_cursor: null });
    if (url.endsWith("/scopes/scope-1")) return Response.json(scope);
    throw new Error(`Unexpected request: ${url}`);
  }));
}

test("a legacy artifact URL opens its current revision in the run workspace", async () => {
  const revision = { id: "rev-1", run_id: "run-1", scope_id: "scope-1", execution_id: null,
    output_key: "analysis", collection_key: "", body: { schema: "text", data: { kind: "string", value: "draft" } },
    predecessor_id: null, created_at: "2026-01-01T00:00:00Z", version: 1 };
  const output = { id: "slot-1", run_id: "run-1", scope_id: "scope-1", output_key: "analysis", collection_key: "",
    current_revision_id: "rev-1", current_revision: revision, version: 1 } as OperatorOutputSlotView;
  stubProjection(makeScopeView({ outputs: [output] }));
  render(<QueryClientProvider client={client()}><ArtifactWorkspaceRedirectView artifactId={"rev-1" as ArtifactId} onBack={() => undefined} /></QueryClientProvider>);
  await waitFor(() => expect(window.location.hash).toBe("#oakridge/run/run-1/artifact/rev-1"));
});

test("a legacy session URL opens the owning run's session pane", async () => {
  const execution = { id: "execution-1", scope_id: "scope-1", worker_key: "author", generation: 1,
    status: "terminal", result: { schema: "text", data: { kind: "string", value: "sid-1" } }, version: 1 } as OperatorExecutionView;
  stubProjection(makeScopeView({ executions: [execution] }));
  render(<QueryClientProvider client={client()}><SessionWorkspaceRedirectView sessionId={"sid-1" as Sid} onBack={() => undefined} /></QueryClientProvider>);
  await waitFor(() => expect(window.location.hash).toBe("#oakridge/run/run-1/session/sid-1"));
});
