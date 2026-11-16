import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { WorkflowDefDetail } from "../components/organisms/WorkflowDefDetail";
import { useGradingConfigurationWrites, usePublishedGradingDefinitions, GRADING_CONFIG_QUERY_KEY } from "../hooks/useGradingConfiguration";
import { configRead, publishedConfig } from "./grading-config-fixture";
import { readGradingConfiguration } from "../client-grading-config";
const definition = fixture.definition as unknown as OperatorDefinitionDetail;
vi.mock("../hooks/useWorkflowDef", () => ({ useWorkflowDef: () => ({ data: definition, isPending: false, isError: false }) }));
vi.mock("../client-grading-config", () => ({ readGradingConfiguration: vi.fn() }));
const published = { ...publishedConfig().definitions[0], id: "brief.quality", targets: [{ artifact: "brief", selector: "/build_items/*" }], evaluators: [{ runner: "human" as const }] };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function show(stage = "brief") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><WorkflowDefDetail definitionId={definition.definition_id} selection={{ kind: "stage", stage, tab: "artifacts" }} onNavigate={vi.fn()} onBack={vi.fn()} /></QueryClientProvider>);
  return client;
}
it("shows published requirements and shared editor links on the matching artifact contract", async () => {
  vi.mocked(readGradingConfiguration).mockResolvedValue({ ok: true, value: { ...configRead(), latest: { ...publishedConfig(), definitions: [published] } } });
  show();
  const region = await screen.findByRole("region", { name: "Independent grading" });
  await within(region).findByRole("link", { name: "Open brief.quality in grading editor" });
  expect(region.textContent).toContain("/build_items/*");
  expect(region.textContent).toContain(published.question.text);
  expect(region.textContent).toContain("human");
  expect(region.textContent).toContain("subject");
  expect(region.textContent).toContain("Separate from this workflow's reviews. Grading runs only for runs launched with grading enabled.");
  expect(within(region).getByRole("link").getAttribute("href")).toMatch(/\/definitions\/brief.quality$/);
  expect(screen.queryByRole("switch")).toBeNull();
});
it("leaves unmatched contracts visible", async () => {
  vi.mocked(readGradingConfiguration).mockResolvedValue({ ok: true, value: { ...configRead(), latest: { ...publishedConfig(), definitions: [published] } } });
  show("planning");
  await screen.findByText("No published grading definition targets this artifact.");
});
it("keeps contracts available on grading read failure", async () => {
  vi.mocked(readGradingConfiguration).mockResolvedValue({ ok: false, feedback: { kind: "transport_error", detail: "offline" } });
  show();
  await waitFor(() => expect(screen.getAllByText("Grading configuration unavailable: offline")).toHaveLength(2));
  expect(screen.getByText("Definition contract")).toBeTruthy();
});
it("invalidates published reads after recordWrite and picks up the next published definition", async () => {
  vi.mocked(readGradingConfiguration).mockResolvedValueOnce({ ok: true, value: { ...configRead(), latest: null } }).mockResolvedValue({ ok: true, value: { ...configRead(), latest: { ...publishedConfig(), definitions: [published] } } });
  let write = () => {};
  function Reader() { const query = usePublishedGradingDefinitions(); write = useGradingConfigurationWrites().recordWrite; return <p>{query.definitions.map(source => source.id).join(",") || "empty"}</p>; }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Reader /></QueryClientProvider>);
  await waitFor(() => expect(readGradingConfiguration).toHaveBeenCalledTimes(1));
  await act(async () => { write(); });
  expect(client.getQueryState([...GRADING_CONFIG_QUERY_KEY, "published"])?.isInvalidated).toBe(true);
  await act(async () => { await client.refetchQueries({ queryKey: [...GRADING_CONFIG_QUERY_KEY, "published"] }); });
  await screen.findByText("brief.quality");
});
it("lists each matching shared definition once and excludes unrelated targets", async () => {
  const assessment = { ...published, id: "assessment.quality", targets: [{ artifact: "assessment", selector: "/items/*" }] };
  const unrelated = { ...published, id: "unrelated", targets: [{ artifact: "absent", selector: "/items/*" }] };
  vi.mocked(readGradingConfiguration).mockResolvedValue({ ok: true, value: { ...configRead(), latest: { ...publishedConfig(), definitions: [published, assessment, unrelated] } } });
  show();
  const region = screen.getByRole("region", { name: "Independent grading definitions" });
  await within(region).findByRole("link", { name: "Open brief.quality in grading editor" });
  expect(within(region).getAllByRole("link")).toHaveLength(2);
  expect(region.textContent).toContain("brief › brief");
  expect(region.textContent).toContain("assessment");
  expect(region.textContent).not.toContain("unrelated");
});
it("shows the workflow empty state when no published definition matches", async () => {
  vi.mocked(readGradingConfiguration).mockResolvedValue({ ok: true, value: { ...configRead(), latest: null } });
  show();
  await screen.findByText("No published grading definition targets this workflow's artifacts.");
});
