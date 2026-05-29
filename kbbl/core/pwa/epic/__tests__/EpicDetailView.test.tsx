import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { EpicDetailView } from "../EpicDetailView";

type EpicStage = "spec" | "plan" | "build" | "assess";

const STAGE_DEFAULTS_CONFIG = {
  defaultWorkdir: "/tmp",
  defaultRuntimeId: "claude-code",
  runtimes: [
    {
      id: "claude-code",
      label: "Claude Code",
      models: [
        { value: "claude-opus-4-8", label: "Opus 4.8" },
        { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      ],
      supportsCompaction: true,
    },
  ],
  stageDefaults: {
    planner: { runtime: "claude-code", model: "claude-opus-4-8" },
    build: { runtime: "claude-code", model: "claude-sonnet-4-6" },
  },
};

function makeFixture(
  current_stage: EpicStage,
  routing?: {
    planner_runtime?: string | null;
    planner_model?: string | null;
    build_runtime?: string | null;
    build_model?: string | null;
  },
) {
  return {
    epic: {
      id: "epic-1",
      project_id: "proj-1",
      title: "My Epic",
      status: "active",
      current_stage,
      created_at: "2024-01-01T00:00:00Z",
      planner_runtime: routing?.planner_runtime ?? null,
      planner_model: routing?.planner_model ?? null,
      build_runtime: routing?.build_runtime ?? null,
      build_model: routing?.build_model ?? null,
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

function makeFetch(
  stage: EpicStage,
  routing?: Parameters<typeof makeFixture>[1],
) {
  return vi.fn().mockImplementation((url: string) => {
    if (url === "/config") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(STAGE_DEFAULTS_CONFIG),
      });
    }
    if ((url as string).includes("/plans/plan-1/assessment")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ summary: "looks good" }),
      });
    }
    if ((url as string).includes("/epics/epic-1")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeFixture(stage, routing)),
      });
    }
    if ((url as string).includes("/spec-discrepancies")) {
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

  it("assess stage: renders ReviewDrilldown and highlights Assess tile", async () => {
    vi.stubGlobal("fetch", makeFetch("assess"));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    expect(await screen.findByRole("heading", { name: "Assessment" })).toBeTruthy();

    const tiles = screen.getAllByRole("listitem");
    const currentTile = tiles.find(
      (el) => el.getAttribute("aria-current") === "step",
    );
    expect(currentTile?.textContent).toMatch(/Assess/i);
  });
});

describe("EpicDetailView routing chips", () => {
  it("shows stageDefaults when routing columns are null", async () => {
    vi.stubGlobal("fetch", makeFetch("build"));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    // Wait for epic to load
    await screen.findByRole("heading", { name: "Cohorts" });

    await waitFor(() => {
      const chips = document.querySelectorAll(".epic-detail__chip--routing");
      expect(chips.length).toBe(2);
      const texts = Array.from(chips).map((c) => c.textContent ?? "");
      expect(texts.some((t) => t.includes("planner:") && t.includes("claude-code") && t.includes("claude-opus-4-8"))).toBe(true);
      expect(texts.some((t) => t.includes("build:") && t.includes("claude-code") && t.includes("claude-sonnet-4-6"))).toBe(true);
    });
  });

  it("shows epic routing values when columns are non-null", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch("build", {
        planner_runtime: "codex",
        planner_model: "gpt-5.1-codex",
        build_runtime: "claude-code",
        build_model: "claude-opus-4-8",
      }),
    );
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    await screen.findByRole("heading", { name: "Cohorts" });

    await waitFor(() => {
      const chips = document.querySelectorAll(".epic-detail__chip--routing");
      expect(chips.length).toBe(2);
      const texts = Array.from(chips).map((c) => c.textContent ?? "");
      expect(texts.some((t) => t.includes("planner:") && t.includes("codex") && t.includes("gpt-5.1-codex"))).toBe(true);
      expect(texts.some((t) => t.includes("build:") && t.includes("claude-code") && t.includes("claude-opus-4-8"))).toBe(true);
    });
  });

  it("falls back to em-dash when column is null and config is not yet loaded", async () => {
    // Simulate config never resolving by making /config return an error
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url === "/config") {
        return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
      }
      if ((url as string).includes("/epics/epic-1")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeFixture("build")),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }));
    renderWithClient(<EpicDetailView epic_id="epic-1" />);

    await screen.findByRole("heading", { name: "Cohorts" });

    await waitFor(() => {
      const chips = document.querySelectorAll(".epic-detail__chip--routing");
      expect(chips.length).toBe(2);
      const texts = Array.from(chips).map((c) => c.textContent ?? "");
      // null columns + failed config → em-dash fallback
      expect(texts.some((t) => t.includes("planner:") && t.includes("—"))).toBe(true);
      expect(texts.some((t) => t.includes("build:") && t.includes("—"))).toBe(true);
    });
  });
});
