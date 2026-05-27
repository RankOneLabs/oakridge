import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { RepoDashboardView } from "../RepoDashboardView";

const PROJECT_FIXTURE = {
  id: "proj-1",
  name: "My Project",
  repo_path: "/code/my-project",
};

const EPICS_FIXTURE = [
  {
    id: "epic-1",
    title: "Epic One",
    status: "pending",
    current_stage: "spec",
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "epic-2",
    title: "Epic Two",
    status: "active",
    current_stage: "plan",
    created_at: "2024-01-02T00:00:00Z",
  },
  {
    id: "epic-3",
    title: "Epic Three",
    status: "complete",
    current_stage: "review",
    created_at: "2024-01-03T00:00:00Z",
  },
  {
    id: "epic-4",
    title: "Epic Four",
    status: "archived",
    current_stage: "build",
    created_at: "2024-01-04T00:00:00Z",
  },
];

const ACTIVE_EPICS_FIXTURE = EPICS_FIXTURE.filter((e) => e.status === "active");

function makeFetchStub(epicsData = EPICS_FIXTURE) {
  return vi.fn().mockImplementation((url: string) => {
    if ((url as string).includes("/projects/")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(PROJECT_FIXTURE),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(epicsData),
    });
  });
}

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RepoDashboardView", () => {
  it("renders all rows from a four-row fixture", async () => {
    vi.stubGlobal("fetch", makeFetchStub());
    renderWithClient(<RepoDashboardView project_id="proj-1" onBack={vi.fn()} />);

    for (const epic of EPICS_FIXTURE) {
      expect(await screen.findByText(epic.title)).toBeTruthy();
    }
  });

  it("clicking 'active' filter refetches with status=active and updates rendered set", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/projects/")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(PROJECT_FIXTURE),
        });
      }
      if ((url as string).includes("status=active")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(ACTIVE_EPICS_FIXTURE),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(EPICS_FIXTURE),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<RepoDashboardView project_id="proj-1" onBack={vi.fn()} />);

    // Wait for initial full render
    expect(await screen.findByText("Epic One")).toBeTruthy();

    // Click "active" filter button
    fireEvent.click(screen.getByRole("button", { name: "active" }));

    // Non-active rows should disappear; active row stays
    await waitFor(() => {
      expect(screen.queryByText("Epic One")).toBeNull();
      expect(screen.queryByText("Loading epics…")).toBeNull();
    });
    expect(screen.getByText("Epic Two")).toBeTruthy();

    // Fetch must have been called with status=active
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls.some((u) => u.includes("status=active"))).toBe(true);
  });

  it("clicking the 'View' link sets window.location.hash to #epic/<id>", async () => {
    vi.stubGlobal("fetch", makeFetchStub([EPICS_FIXTURE[0]]));
    renderWithClient(<RepoDashboardView project_id="proj-1" onBack={vi.fn()} />);

    const viewLink = await screen.findByRole("link", { name: "View" });
    fireEvent.click(viewLink);

    expect(window.location.hash).toBe(`#epic/${EPICS_FIXTURE[0].id}`);
  });
});
