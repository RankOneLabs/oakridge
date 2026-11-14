import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { InstallStatusContent } from "../views/StatusView";
import { installStatus } from "../__fixtures__/install-status";
import { ManualMergeBadges } from "../components/molecules/ManualMergeIndications";
import { MANUAL_MERGE_INDICATION } from "../state/manual-merge";
import { sampleRun } from "../__fixtures__/read-models";
import definitionFixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
const definition = definitionFixture.definition as unknown as OperatorDefinitionDetail;
it("optional services show fixes and no installation failure banner", () => {
  render(<InstallStatusContent status={installStatus} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Fix: Select a PR integration")).toBeTruthy();
  expect(screen.getByText("Fix: Start with --observation")).toBeTruthy();
});
it("required failure shows the served verdict and check detail and fix", () => {
  render(<InstallStatusContent status={{ ...installStatus, installation_failed: true, checks: [{ kind: "failed", id: "kbbl", label: "kbbl", required: true, detail: "Required kbbl offline", fix: "Start kbbl now" }] }} />);
  expect(screen.getByRole("alert").textContent).toContain("Installation failure");
  expect(screen.getByText(/Required kbbl offline/)).toBeTruthy();
  expect(screen.getByText("Fix: Start kbbl now")).toBeTruthy();
});
it.each([ ["local", "Local"], ["authenticated_network", "Authenticated network"], ["insecure_network", "Insecure network"] ] as const)("renders %s access mode", (kind, label) => {
  render(<InstallStatusContent status={{ ...installStatus, access_mode: { kind, bind_host: "host.example" } }} />);
  expect(screen.getByText(`${label} · host.example`)).toBeTruthy();
});
it("launch blocks render definition name and the typed error detail", () => {
  render(<InstallStatusContent status={{ ...installStatus, launch_blocks: [{ definition_id: definition.definition_id, definition_name: "Blocked development", error: { kind: "integration_none", integration: "none", definition_id: definition.definition_id, detail: "Needs pull request integration", fix: "Choose github-cli" } }] }} />);
  expect(screen.getByText("Blocked development")).toBeTruthy();
  expect(screen.getByText("Needs pull request integration")).toBeTruthy();
});
it("merge stage units show the exact persistent badge without interaction", () => {
  const unit = sampleRun.units.find((unit) => unit.stage === "cohort");
  if (!unit) throw new Error("fixture has no cohort unit");
  render(<ManualMergeBadges run={{ ...sampleRun, pr_integration: "github-cli", units: [{ ...unit, unit_id: "cohort", stage: "cohort", label: "Cohort" }, { ...unit, unit_id: "integration", stage: "integration", label: "Integration" }] }} definition={definition} />);
  expect(screen.getAllByTestId("manual-merge-indication").map((node) => node.textContent)).toEqual([`Cohort: ${MANUAL_MERGE_INDICATION}`, `Integration: ${MANUAL_MERGE_INDICATION}`]);
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { RunDetailView } from "../views/RunDetailView";
vi.mock("../components/organisms/RunWorkspace", () => ({ RunWorkspace: () => <div>Workspace</div> }));
it("RunDetailView shows the badge before any operator interaction", async () => {
  const run = { ...sampleRun, definition_id: definition.definition_id, pr_integration: "github-cli" as const };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["oakridge", "operator-run", run.run_id], run);
  client.setQueryData(["oakridge", "pinned-run-definition", run.run_id], definition);
  render(<QueryClientProvider client={client}><RunDetailView runId={run.run_id} routePane={null} onBack={() => {}} /></QueryClientProvider>);
  expect((await screen.findAllByTestId("manual-merge-indication"))[0]?.textContent).toContain(MANUAL_MERGE_INDICATION);
});
it("an older github-cli run loads pinned review metadata without consulting the current catalog", async () => {
  const run = { ...sampleRun, pr_integration: "github-cli" as const };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["oakridge", "operator-run", run.run_id], run);
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return String(input).endsWith("/definition") ? Response.json(definition) : new Response("not in current catalog", { status: 404 });
  }));
  try {
    render(<QueryClientProvider client={client}><RunDetailView runId={run.run_id} routePane={null} onBack={() => {}} /></QueryClientProvider>);
    const badges = await screen.findAllByTestId("manual-merge-indication");
    expect(badges[0]?.textContent).toContain(MANUAL_MERGE_INDICATION);
    expect(requests.some((path) => path.includes("/runs/") && path.endsWith("/definition"))).toBe(true);
    expect(requests.some((path) => path.includes("/definitions/"))).toBe(false);
  } finally { vi.unstubAllGlobals(); client.clear(); }
});
