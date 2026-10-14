import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import { fetchOakridgeConfig, fetchOperatorInbox, fetchOperatorRuns } from "../client";
import {
  makeDecision, makeInboxDecision, makeOakridgeConfig, makeInboxPage,
  makeRunView, makeRunUnitSummary, makeUnitView,
} from "../__fixtures__/read-models";
import { RunListView } from "../views/RunListView";
import { ReviewInboxView } from "../views/ReviewInboxView";
import { RunOverviewPane } from "../components/organisms/RunOverviewPane";
import { OakridgeShell } from "../OakridgeShell";

vi.mock("../client", () => ({ fetchOakridgeConfig: vi.fn(), fetchOperatorRuns: vi.fn(), fetchOperatorInbox: vi.fn(),
  setOperatorRunArchived: vi.fn() }));

const show = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  {ui}
</QueryClientProvider>);
const list = (onSelectRun = vi.fn(), onDefinitions = vi.fn()) => show(<RunListView onSelectRun={onSelectRun}
  onNewRun={() => undefined} onDefinitions={onDefinitions} onProjects={() => undefined} />);

beforeEach(() => {
  vi.mocked(fetchOperatorRuns).mockResolvedValue([]);
  vi.mocked(fetchOperatorInbox).mockResolvedValue(makeInboxPage());
  vi.mocked(fetchOakridgeConfig).mockResolvedValue(makeOakridgeConfig());
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("generated run catalog", () => {
  it("opens the pinned definitions surface", async () => {
    const onDefinitions = vi.fn();
    list(vi.fn(), onDefinitions);
    fireEvent.click(await screen.findByRole("button", { name: "Definitions" }));
    expect(onDefinitions).toHaveBeenCalledOnce();
  });

  it("shows a pending run read", () => {
    vi.mocked(fetchOperatorRuns).mockImplementation(() => new Promise(() => undefined));
    list();
    expect(screen.getByRole("status").textContent).toContain("Loading runs");
  });

  it("renders one lifecycle card per generated run", async () => {
    vi.mocked(fetchOperatorRuns).mockResolvedValue([makeRunView(), makeRunView({ run_id: "run-2", definition_digest: "digest-2" })]);
    list();
    expect(await screen.findAllByTestId("or-cohort-lifecycle-card")).toHaveLength(2);
    expect(screen.getByText("run-1")).toBeTruthy();
    expect(screen.getByText("run-2")).toBeTruthy();
  });

  it("shows generated inbox attention instead of a parked gate count", async () => {
    vi.mocked(fetchOperatorRuns).mockResolvedValue([makeRunView({ run_id: "run-2" })]);
    vi.mocked(fetchOperatorInbox).mockResolvedValue(makeInboxPage({ items: [makeInboxDecision({ run_id: "run-2" })] }));
    list();
    expect((await screen.findByTestId("or-cohort-lifecycle-card")).textContent).toContain("1 need attention");
  });

  it("shows an empty state", async () => {
    list();
    expect(await screen.findByText("No runs yet.")).toBeTruthy();
  });

  it("opens a selected run by ID", async () => {
    const onSelectRun = vi.fn();
    vi.mocked(fetchOperatorRuns).mockResolvedValue([makeRunView()]);
    list(onSelectRun);
    fireEvent.click(await screen.findByTestId("or-cohort-lifecycle-card"));
    expect(onSelectRun).toHaveBeenCalledWith("run-1");
  });

  it("reports a failed run read", async () => {
    vi.mocked(fetchOperatorRuns).mockRejectedValue(new Error("server down"));
    list();
    expect((await screen.findByRole("alert")).textContent).toContain("server down");
  });
});

describe("unit overview and review work", () => {
  it("lists generated units and their live decisions", () => {
    const run = makeRunView({ units: [makeRunUnitSummary({ unit_id: "build", label: "Build", asks: ["approve"] })] });
    const unit = makeUnitView({ unit_id: "build", label: "Build", decisions: [makeDecision()] });
    show(<RunOverviewPane run={run} units={[unit]} onOpenUnit={() => undefined} />);
    expect(screen.getAllByTestId("or-stage-row")).toHaveLength(1);
    expect(screen.getByTestId("or-gate-card").textContent).toContain("Approve");
  });

  it("routes an inbox decision to its run and unit", async () => {
    const onSelectUnit = vi.fn();
    vi.mocked(fetchOperatorInbox).mockResolvedValue(makeInboxPage({ items: [makeInboxDecision({
      run_id: "run-2", unit_id: "build", label: "Approve build",
    })] }));
    show(<ReviewInboxView onSelectUnit={onSelectUnit} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open work" }));
    expect(onSelectUnit).toHaveBeenCalledWith("run-2", "build");
  });

  it("shows an empty global review inbox", async () => {
    show(<ReviewInboxView onSelectUnit={() => undefined} />);
    expect(await screen.findByTestId("or-review-inbox-empty")).toBeTruthy();
  });
});

it("shows an unavailable notice when the authority config is disabled", async () => {
  vi.mocked(fetchOakridgeConfig).mockResolvedValue(makeOakridgeConfig({ available: false }));
  show(<OakridgeShell route={{ sub: "runs" }} />);
  expect((await screen.findByRole("alert")).textContent).toContain("unavailable");
});
