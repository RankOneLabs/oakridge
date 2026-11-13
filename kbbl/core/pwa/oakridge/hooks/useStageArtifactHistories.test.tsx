import { afterEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import captured from "../__fixtures__/v2-adapter-sample.json";
import { sampleUnits, withUnitFields } from "../__fixtures__/read-models";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { unitPath } from "../client-http";
import { useStageArtifactHistories } from "./useStageArtifactHistories";

const history = captured.artifact as unknown as OperatorArtifactDetail;
const owner = sampleUnits.find((unit) => unit.unit_id === history.unit_id);
const artifact = owner?.artifacts.find((artifact) => artifact.artifact_key === history.artifact_key);
const last = history.revisions.at(-1);
if (!owner || !artifact || !last) throw new Error("captured history requires a published artifact and owning unit");
const unit = withUnitFields(owner, { artifacts: [artifact] });
const clients: QueryClient[] = [];
const wrapper = ({ children }: { children: ReactNode }) => {
  const client = clients[0];
  if (!client) throw new Error("query client fixture missing");
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
interface StageHistoryHookProps { readonly selected: OperatorUnitView | null }
function setup() {
  clients.push(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return renderHook<ReturnType<typeof useStageArtifactHistories>, StageHistoryHookProps>(({ selected }) => useStageArtifactHistories(selected), { wrapper, initialProps: { selected: unit } });
}
afterEach(() => { for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); });

test("opening a unit fetches only its output history and reuses it on unchanged inventory polls", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(history));
  const view = setup();
  await waitFor(() => expect(view.result.current.data).toEqual([history]));
  await act(async () => view.rerender({ selected: withUnitFields(unit, { input: { status_poll: 2 } }) }));
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    `/oakridge/api${unitPath(unit.run_id, unit.unit_id)}/artifacts/${encodeURIComponent(artifact.artifact_key)}`,
  ]);
});
test("a new recorded publication refreshes only the changed history", async () => {
  const nextRevision = { ...last, id: "recorded-new-revision", number: last.number + 1 };
  const nextHistory = { ...history, revisions: [...history.revisions, nextRevision] };
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(history)).mockResolvedValueOnce(Response.json(nextHistory));
  const view = setup();
  await waitFor(() => expect(view.result.current.data).toEqual([history]));
  view.rerender({ selected: withUnitFields(unit, { artifacts: [{ ...artifact, revision_count: artifact.revision_count + 1, latest_revision: nextRevision }] }) });
  await waitFor(() => expect(view.result.current.data).toEqual([nextHistory]));
  expect(fetch).toHaveBeenCalledTimes(2);
});
test("returning to a previously opened unit uses its cached recorded history", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(history));
  const view = setup();
  await waitFor(() => expect(view.result.current.data).toEqual([history]));
  view.rerender({ selected: null });
  expect(view.result.current.data).toBeUndefined();
  view.rerender({ selected: unit });
  await waitFor(() => expect(view.result.current.data).toEqual([history]));
  expect(fetch).toHaveBeenCalledTimes(1);
});
