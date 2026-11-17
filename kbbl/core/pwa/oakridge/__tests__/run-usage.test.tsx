import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readRunUsage } from "../client";
import { formatUsageUsd, selectUsageBasis, selectUsageCohorts, selectUsageCoverage, selectUsageTotals, selectUsageVerification } from "../lib/run-usage";
import { RunUsageSummary } from "../components/molecules/RunUsageSummary";
import { RunDetailView } from "../views/RunDetailView";
import { usageFixture } from "./run-usage-fixture";
vi.mock("../components/organisms/RunWorkspace", () => ({ RunWorkspace: () => null }));
vi.mock("../components/organisms/ManualMergeIndications", () => ({ ManualMergeIndications: () => null }));
vi.mock("../hooks/useRunUsage", () => ({ useRunUsage: () => ({ data: usageFixture, isPending: false, isError: false }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("reads the generated usage response through the run endpoint", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json(usageFixture)); vi.stubGlobal("fetch", fetch);
  expect(await readRunUsage("run")).toEqual(usageFixture);
  expect(fetch.mock.calls[0]?.[0]).toBe("/oakridge/api/api/runs/run/usage");
});
it("selects one row per cohort with endpoint cost and time figures", () => {
  expect(selectUsageCohorts(usageFixture)).toEqual(["one", "two"].map((key) => ({ unit_id: key, label: key, first_pass_usd: 2, rework_usd: 1, agent_ms: 2000, human_wait_ms: 2000, approximate: true })));
});
it("keeps missing cost distinct from zero", () => { expect([formatUsageUsd(null), formatUsageUsd(0)]).toEqual(["Unreported", "$0.00"]); });
it("preserves all coverage counts including zero", () => { expect(selectUsageCoverage(usageFixture)).toEqual(usageFixture.coverage); });
it("reads totals and optional verification without recalculating them", () => {
  expect(selectUsageTotals(usageFixture)).toEqual({ ...usageFixture.totals, rework: usageFixture.rework });
  expect(selectUsageVerification({ ...usageFixture, verification: null })).toBeNull();
});
it("labels both cost bases", () => { expect([selectUsageBasis("list_price_equivalent"), selectUsageBasis("provider_charged")]).toEqual(["list-price equivalent", "provider charged"]); });
it("renders cohort rows, totals, durations, zero coverage and cost basis per figure", () => {
  render(<RunUsageSummary usage={usageFixture} />);
  expect(screen.getAllByTestId("usage-cohort")).toHaveLength(2);
  expect(screen.getAllByTestId("usage-cohort")[0].textContent).toContain("$2.00 list-price equivalent$1.00 list-price equivalent2.0s≈ 2.0s");
  expect(screen.getByTestId("usage-totals").textContent).toContain("Run total: $2.00");
  expect(screen.getByTestId("usage-coverage").textContent).toContain("0 reported · 0 partial · 0 absent · Cost-unreported sessions: 0");
  expect(screen.getAllByText("list-price equivalent")).toHaveLength(6);
  expect(screen.getByText("provider charged")).toBeTruthy();
});
it("renders unreported costs and omits unavailable verification", () => {
  render(<RunUsageSummary usage={{ ...usageFixture, verification: null, units: [{ ...usageFixture.units[0], first_pass: { ...usageFixture.units[0].first_pass, usd: null } }] }} />);
  expect(screen.getByText("Unreported")).toBeTruthy();
  expect(screen.queryByText("provider charged")).toBeNull();
  expect(screen.queryByText("$0.00")).toBeNull();
});
it("mounts usage on the run detail route", () => {
  render(<RunDetailView runId="run" routePane={null} onBack={() => {}} />);
  expect(screen.getByRole("region", { name: "Run usage" })).toBeTruthy();
});
