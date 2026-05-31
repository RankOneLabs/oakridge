import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { RunBuildButton } from "./RunBuildButton";

interface CohortResponse {
  status?: string;
  current_session_ref: string | null;
  current_session_stage: string | null;
  current_session_status: string | null;
}

function mockCohortFetch(body: CohortResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(body),
    }),
  );
}

// Fresh client per render so each test starts with an empty cache and no
// retry-induced waits. retry=false on both queries and mutations.
function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RunBuildButton", () => {
  it("shows Run build when no session ref is set", async () => {
    mockCohortFetch({
      current_session_ref: null,
      current_session_stage: null,
      current_session_status: null,
    });

    renderWithClient(<RunBuildButton briefId="brief-1" cohortId="cohort-1" />);

    expect(await screen.findByRole("button", { name: /run build/i })).toBeTruthy();
  });

  it("shows waiting indicator (no button) when deps are unmet (ready_to_build)", async () => {
    mockCohortFetch({
      status: "ready_to_build",
      current_session_ref: null,
      current_session_stage: null,
      current_session_status: null,
    });

    renderWithClient(<RunBuildButton briefId="brief-1" cohortId="cohort-1" />);

    expect(await screen.findByText(/waiting on dependencies/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run build/i })).toBeNull();
  });

  it("shows Run build when the session is ended (stale ref)", async () => {
    // The regression this whole PR fixes: dispatcher never clears
    // current_session_ref on session end, so it stays populated after a
    // completed build. Status="ended" must NOT count as live.
    mockCohortFetch({
      current_session_ref: "sess-old",
      current_session_stage: "build",
      current_session_status: "ended",
    });

    renderWithClient(<RunBuildButton briefId="brief-1" cohortId="cohort-1" />);

    expect(await screen.findByRole("button", { name: /run build/i })).toBeTruthy();
    expect(screen.queryByText(/build running/i)).toBeNull();
  });

  it("shows Run build when the manager doesn't know the ref (status null)", async () => {
    // Post-server-restart: ref outlives the in-memory manager.
    mockCohortFetch({
      current_session_ref: "sess-gone",
      current_session_stage: "build",
      current_session_status: null,
    });

    renderWithClient(<RunBuildButton briefId="brief-1" cohortId="cohort-1" />);

    expect(await screen.findByRole("button", { name: /run build/i })).toBeTruthy();
  });

  it("shows 'Build running' when stage=build and status is live", async () => {
    mockCohortFetch({
      current_session_ref: "sess-live-1234",
      current_session_stage: "build",
      current_session_status: "live",
    });

    renderWithClient(<RunBuildButton briefId="brief-1" cohortId="cohort-1" />);

    expect(await screen.findByText(/build running — session sess-liv/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run build/i })).toBeNull();
  });

  it("shows Run build when ref exists but stage is a planner phase (not build)", async () => {
    // Stale planner2 ref on the same column must not hide the recovery
    // button — the guard explicitly checks stage === "build".
    mockCohortFetch({
      current_session_ref: "sess-planner",
      current_session_stage: "planner2",
      current_session_status: "live",
    });

    renderWithClient(<RunBuildButton briefId="brief-1" cohortId="cohort-1" />);

    expect(await screen.findByRole("button", { name: /run build/i })).toBeTruthy();
  });

  it("hides Run build while the initial status check is in flight", async () => {
    // First render: fetch promise is pending. The button should show the
    // "Checking build status…" placeholder instead of jumping straight to
    // Run build (which would let an overeager click race the auto-dispatch
    // that brief.approved triggers in dispatch-hooks).
    let resolveFetch: (value: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((res) => { resolveFetch = res; }),
      ),
    );

    renderWithClient(<RunBuildButton briefId="brief-1" cohortId="cohort-1" />);

    expect(screen.getByText(/checking build status/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run build/i })).toBeNull();

    // Resolve so the test cleans up without dangling state.
    resolveFetch({
      ok: true,
      json: vi.fn().mockResolvedValue({
        current_session_ref: null,
        current_session_stage: null,
        current_session_status: null,
      }),
    });

    await waitFor(() => {
      expect(screen.queryByText(/checking build status/i)).toBeNull();
    });
  });
});
