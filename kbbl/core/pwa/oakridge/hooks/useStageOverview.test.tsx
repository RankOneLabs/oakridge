import { afterEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import captured from "../__fixtures__/v2-adapter-sample.json";
import { sampleUnits, withUnitFields } from "../__fixtures__/read-models";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
import { runPath, unitPath } from "../client-http";
import { useStageOverview } from "./useStageOverview";

afterEach(() => vi.restoreAllMocks());
test("the full stage overview reads only its own history and does not repeat it on a status poll", async () => {
  const history = captured.artifact as unknown as OperatorArtifactDetail;
  const owner = sampleUnits.find((candidate) => candidate.unit_id === history.unit_id);
  const artifact = owner?.artifacts.find((candidate) => candidate.artifact_key === history.artifact_key);
  if (!owner || !artifact) throw new Error("captured artifact requires its owning unit");
  const selected = withUnitFields(owner, { artifacts: [artifact] });
  let inventory = sampleUnits.map((candidate) => candidate.unit_id === selected.unit_id ? selected : candidate);
  const historyPath = `/oakridge/api${unitPath(selected.run_id, selected.unit_id)}/artifacts/${encodeURIComponent(artifact.artifact_key)}`;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path === `/oakridge/api${runPath(selected.run_id)}/units`) return Response.json(inventory);
    if (path.endsWith("/stages")) return Response.json([]);
    if (path.includes("/tasks?")) return Response.json({ items: [], total: 0, limit: 200, offset: 0 });
    if (path === historyPath) return Response.json(history);
    return Response.json({ error: "unexpected stage read" }, { status: 404 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useStageOverview(selected.run_id, selected.unit_id), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.artifacts.data).toEqual([history]));
    inventory = inventory.map((candidate) => candidate.unit_id === selected.unit_id ? withUnitFields(candidate, { input: { polled: true } }) : candidate);
    await act(async () => { await view.result.current.units.refetch(); });
    await waitFor(() => expect(view.result.current.source?.unit.input).toEqual({ polled: true }));
    expect(fetch.mock.calls.flatMap(([path]) => String(path).includes("/artifacts/") ? [path] : [])).toEqual([historyPath]);
  } finally { view.unmount(); client.clear(); }
});
