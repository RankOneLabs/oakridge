import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { EpicDetailView } from "../EpicDetailView";

type EpicStage = "spec" | "plan" | "build" | "review";

function makeFixture(current_stage: EpicStage) {
  return {
    epic: {
      id: "epic-1",
      project_id: "proj-1",
      title: "My Epic",
      status: "active",
      current_stage,
      created_at: "2024-01-01T00:00:00Z",
    },
    spec:
      current_stage === "spec"
        ? { id: "spec-1", internal_status: "discrepancies" }
        : null,
    plan:
      current_stage === "plan"
        ? { id: "plan-1", title: "My Plan", status: "approved" }
        : null,
    cohorts: [
      {
        id: "cohort-1",
        brief_id: "brief-1",
        title: "Cohort One",
        position: 1,
        status: "done",
      },
    ],
    assessment_present: current_stage === "review",
  };
}

function makeFetch(stage: EpicStage) {
  return vi.fn().mockImplementation((url: string) => {
    if ((url as string).includes("/epics/epic-1/assessment")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ summary: "looks good" }),
      });
    }
    if ((url as string).includes("/epics/epic-1")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeFixture(stage)),
      });
    }
    if ((url as string).includes("/discrepancies")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
}

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EpicDetailView", () => {
  it("spec stage: renders DiscrepanciesEditor and highlights Spec tile", async () => {
    vi.stubGlobal("fetch", makeFetch("spec"));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    expect(await screen.findByRole("heading", { name: "Discrepancies" })).toBeTruthy();

    const tiles = screen.getAllByRole("listitem");
    const currentTile = tiles.find(
      (el) => el.getAttribute("aria-current") === "step",
    );
    expect(currentTile).toBeTruthy();
    expect(currentTile?.textContent).toMatch(/Spec/i);
  });

  it("plan stage: renders PlanDrilldown and highlights Plan tile", async () => {
    vi.stubGlobal("fetch", makeFetch("plan"));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View plan" })).toBeTruthy();

    const tiles = screen.getAllByRole("listitem");
    const currentTile = tiles.find(
      (el) => el.getAttribute("aria-current") === "step",
    );
    expect(currentTile?.textContent).toMatch(/Plan/i);
  });

  it("build stage: renders BuildDrilldown and highlights Build tile", async () => {
    vi.stubGlobal("fetch", makeFetch("build"));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    expect(await screen.findByRole("heading", { name: "Cohorts" })).toBeTruthy();

    const tiles = screen.getAllByRole("listitem");
    const currentTile = tiles.find(
      (el) => el.getAttribute("aria-current") === "step",
    );
    expect(currentTile?.textContent).toMatch(/Build/i);
  });

  it("review stage: renders ReviewDrilldown and highlights Review tile", async () => {
    vi.stubGlobal("fetch", makeFetch("review"));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    expect(await screen.findByRole("heading", { name: "Assessment" })).toBeTruthy();

    const tiles = screen.getAllByRole("listitem");
    const currentTile = tiles.find(
      (el) => el.getAttribute("aria-current") === "step",
    );
    expect(currentTile?.textContent).toMatch(/Review/i);
  });
});
