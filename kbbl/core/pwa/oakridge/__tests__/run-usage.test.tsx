import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { readRunUsage } from "../client";
import { formatUsageDuration, formatUsageUsd, selectUsageBasis, selectUsageStatGroups, selectUsageCohorts, selectUsageCoverage, selectUsageTotals, selectUsageVerification } from "../lib/run-usage";
import { RunUsageSummary } from "../components/molecules/RunUsageSummary";
import { RunDetailView } from "../views/RunDetailView";
import { usageFixture } from "./run-usage-fixture";
vi.mock("../components/organisms/RunWorkspace", () => ({ RunWorkspace: () => null }));
vi.mock("../components/organisms/ManualMergeIndications", () => ({ ManualMergeIndications: () => null }));
vi.mock("../components/organisms/OperatorActionsHistory", () => ({ OperatorActionsHistory: () => null }));
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
it("preserves all coverage counts including zero", () => { expect(selectUsageCoverage(usageFixture)).toMatchObject(usageFixture.coverage); });
it("reads totals and optional verification without recalculating them", () => {
  expect(selectUsageTotals(usageFixture)).toEqual({ ...usageFixture.totals, rework: usageFixture.rework });
  expect(selectUsageVerification({ ...usageFixture, verification: null })).toBeNull();
});
it("labels both cost bases", () => { expect([selectUsageBasis("list_price_equivalent"), selectUsageBasis("provider_charged")]).toEqual(["list-price equivalent", "provider charged"]); });
it("formats durations as hours, minutes and seconds, dropping leading zero units", () => {
  expect([0, 999, 45_000, 125_000, 3_600_000, 3_723_400, null].map(formatUsageDuration))
    .toEqual(["0s", "1s", "45s", "2m 5s", "1h 0m 0s", "1h 2m 3s", "Unreported"]);
});
it("groups run totals into cost, time, tokens and coverage with the cost basis stated once", () => {
  const groups = selectUsageStatGroups(usageFixture);
  expect(groups.map((group) => [group.key, group.note])).toEqual([["cost", "list-price equivalent"], ["time", null], ["tokens", null], ["coverage", null]]);
  expect(groups[0]?.stats).toEqual([
    { label: "Run total", value: "$2.00", note: null },
    { label: "Rework", value: "$1.00", note: null },
    { label: "Verification", value: "$0.50", note: "provider charged" },
  ]);
  expect(groups[1]?.stats.map((stat) => stat.value)).toEqual(["1s", "2s", "3s", "6s"]);
});
it("renders cohort rows, grouped totals and zero coverage", () => {
  render(<RunUsageSummary usage={usageFixture} />);
  expect(screen.getAllByTestId("usage-cohort")).toHaveLength(2);
  expect(screen.getAllByTestId("usage-cohort")[0].textContent).toBe("one$2.00$1.002s≈ 2s");
  expect(within(screen.getByRole("region", { name: "Cost" })).getByText("Run total").nextSibling?.textContent).toBe("$2.00");
  expect(within(screen.getByRole("region", { name: "Time" })).getByText("Elapsed").nextSibling?.textContent).toBe("6s");
  expect(within(screen.getByRole("region", { name: "Coverage" })).getByText("Reported").nextSibling?.textContent).toBe("0");
  expect(screen.getAllByText(/list-price equivalent/)).toHaveLength(2);
  expect(screen.getByText("provider charged")).toBeTruthy();
});
it("renders unreported costs and omits unavailable verification", () => {
  render(<RunUsageSummary usage={{ ...usageFixture, verification: null, units: [{ ...usageFixture.units[0], first_pass: { ...usageFixture.units[0].first_pass, usd: null } }] }} />);
  expect(screen.getByText("Unreported")).toBeTruthy();
  expect(screen.queryByText("provider charged")).toBeNull();
  expect(screen.queryByText("$0.00")).toBeNull();
});
it("leaves usage to its workspace pane instead of stacking it above the run", () => {
  render(<RunDetailView runId="run" routePane={null} onBack={() => {}} />);
  expect(screen.queryByRole("region", { name: "Run usage" })).toBeNull();
});

it("excludes external waits and their approximation flags from human wait", () => {
  const unit = usageFixture.units[0];
  const usage = { ...usageFixture, units: [{ ...unit, reviews: [
    { review: "approval", decision: "accept", wait_ms: 1500, approximate: false },
    { review: "merge_confirmation", decision: "confirm", wait_ms: 9000, approximate: true },
    { review: "pr_closed", decision: "confirm", wait_ms: 7000, approximate: true },
  ] }] };
  expect(selectUsageCohorts(usage)[0]).toMatchObject({ human_wait_ms: 1500, approximate: false });
});
it("shows failed sessions separately and warns that all totals may be incomplete", () => {
  const usage = { ...usageFixture, coverage: { ...usageFixture.coverage, failed_sessions: ["missing"], cost_unreported_sessions: ["missing"] } };
  render(<RunUsageSummary usage={usage} />);
  expect(within(screen.getByRole("region", { name: "Coverage" })).getByText("Failed sessions").nextSibling?.textContent).toBe("1");
  expect(screen.getByTestId("usage-cost-unreported").textContent).toBe("Cost-unreported sessions: missing");
  expect(screen.getByRole("status").textContent).toContain("turn, token, time and cost totals may be incomplete");
});
it("does not warn of failed reads when coverage is available", () => {
  render(<RunUsageSummary usage={usageFixture} />);
  expect(within(screen.getByRole("region", { name: "Coverage" })).getByText("Failed sessions").nextSibling?.textContent).toBe("0");
  expect(screen.queryByRole("status")).toBeNull();
});
