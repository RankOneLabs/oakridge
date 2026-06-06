import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { EpicDetailView } from "../EpicDetailView";

type EpicStage = "spec" | "plan" | "build" | "assess";
type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
      current_stage === "plan" || current_stage === "assess"
        ? { id: "plan-1", status: "approved" }
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
    assessment_present: current_stage === "assess",
  };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeFetch(stage: EpicStage): FetchHandler {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/epics/epic-1/status")) {
      expect(init?.method).toBe("PATCH");
      expect(init?.body).toBe(JSON.stringify({ status: "archived" }));
      return jsonResponse({}, { status: 200 });
    }
    if (url.includes("/plans/plan-1/assessment")) {
      return jsonResponse({ summary: "looks good" });
    }
    if (url.includes("/epics/epic-1")) {
      return jsonResponse(makeFixture(stage));
    }
    if (url.includes("/spec-discrepancies")) {
      return jsonResponse([]);
    }
    return jsonResponse([]);
  });
}

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EpicDetailView", () => {
  it("spec stage: renders DiscrepanciesEditor and highlights Spec tile", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch("spec"));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    expect(await screen.findByRole("heading", { name: "Discrepancies" })).toBeTruthy();

    const tiles = screen.getAllByRole("tab");
    const currentTile = tiles.find(
      (el) => el.getAttribute("aria-current") === "step",
    );
    expect(currentTile).toBeTruthy();
    expect(currentTile?.textContent).toMatch(/Spec/i);
  });

  it("plan stage: renders PlanDrilldown and highlights Plan tile", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch("plan"));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View plan" })).toBeTruthy();

    const tiles = screen.getAllByRole("tab");
    const currentTile = tiles.find(
      (el) => el.getAttribute("aria-current") === "step",
    );
    expect(currentTile?.textContent).toMatch(/Plan/i);
  });

  it("build stage: renders BuildDrilldown and highlights Build tile", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch("build"));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    expect(await screen.findByRole("heading", { name: "Cohorts" })).toBeTruthy();

    const tiles = screen.getAllByRole("tab");
    const currentTile = tiles.find(
      (el) => el.getAttribute("aria-current") === "step",
    );
    expect(currentTile?.textContent).toMatch(/Build/i);
  });

  it("assess stage: renders ReviewDrilldown and highlights Assess tile", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch("assess"));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    expect(await screen.findByRole("heading", { name: "Assessment" })).toBeTruthy();

    const tiles = screen.getAllByRole("tab");
    const currentTile = tiles.find(
      (el) => el.getAttribute("aria-current") === "step",
    );
    expect(currentTile?.textContent).toMatch(/Assess/i);
  });

  it("invalidates sidebar specs after a successful archive", async () => {
    const fetchMock: FetchHandler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/epics/epic-1/status")) {
        expect(init?.method).toBe("PATCH");
        expect(init?.body).toBe(JSON.stringify({ status: "archived" }));
        return jsonResponse({}, { status: 200 });
      }

      return makeFetch("spec")(input, init);
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    const { client } = renderWithClient(<EpicDetailView epic_id="epic-1" />);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["epic", "epic-1"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["epics", "proj-1"] });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["specs", { projectId: "proj-1" }],
      });
    });
  });
});
